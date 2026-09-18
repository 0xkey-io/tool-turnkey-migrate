import type { ZeroXKeyTargetClient, TargetPrivateKey } from "./target-0xkey.js";
import type { MigrationItem } from "../types/resources.js";
import {
  accountKey,
  accountsMatch,
  addressKey,
  privateKeyMatch,
} from "./identity.js";

export interface DedupResult {
  isDuplicate: boolean;
  targetId?: string;
  conflict?: boolean;
  reason?: string;
}

export async function checkDuplicate(
  item: MigrationItem,
  target: ZeroXKeyTargetClient,
  cachedKeys?: TargetPrivateKey[],
): Promise<DedupResult> {
  const keys = cachedKeys ?? (await target.listPrivateKeys());
  const meta = item.sourceMetadata;
  const sourceAddresses = new Set(
    meta.type === "wallet"
      ? meta.accounts.map((a) => addressKey(a.addressFormat, a.address))
      : meta.addresses.map((a) => addressKey(a.format, a.address)),
  );
  sourceAddresses.delete("");
  let conflict = false;
  let matchingKeys: string[] = [];
  if (meta.type === "private_key") {
    const matches = keys.filter((key) => privateKeyMatch(meta, key));
    matchingKeys = matches.map((key) => key.privateKeyId);
    if (matches.length > 1) conflict = true;
    for (const key of keys) {
      if (privateKeyMatch(meta, key)) continue;
      if (
        (meta.publicKey &&
          key.publicKey &&
          meta.publicKey.toLowerCase() === key.publicKey.toLowerCase()) ||
        key.addresses.some((a) =>
          sourceAddresses.has(addressKey(a.format, a.address)),
        )
      )
        conflict = true;
    }
  } else {
    conflict = keys.some((key) =>
      key.addresses.some((a) =>
        sourceAddresses.has(addressKey(a.format, a.address)),
      ),
    );
  }
  const wallets = await target.listWallets();
  const matchingWallets: string[] = [];
  for (const wallet of wallets) {
    const accounts = await target.getWalletAccounts(wallet.walletId);
    if (meta.type === "wallet" && accountsMatch(meta.accounts, accounts))
      matchingWallets.push(wallet.walletId);
    else if (
      accounts.some((a) =>
        sourceAddresses.has(addressKey(a.addressFormat, a.address)),
      )
    )
      conflict = true;
    // Empty or malformed account identity cannot be assumed to be a non-match.
    if (accounts.some((a) => !accountKey(a))) conflict = true;
  }
  if (matchingKeys.length === 1 && !conflict)
    return {
      isDuplicate: true,
      targetId: matchingKeys[0],
      reason: "Matching private key identity already exists.",
    };
  if (matchingWallets.length === 1 && !conflict)
    return {
      isDuplicate: true,
      targetId: matchingWallets[0],
      reason: "Matching wallet account identity already exists.",
    };
  if (matchingWallets.length > 1) conflict = true;
  return {
    isDuplicate: false,
    conflict,
    ...(conflict
      ? {
          reason:
            "Target address/public-key overlap is not a complete, unique resource identity.",
        }
      : {}),
  };
}
