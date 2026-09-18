import type { ZeroXKeyTargetClient } from "./target-0xkey.js";
import type { MigrationItem } from "../types/resources.js";
import type { ManifestStore } from "./manifest.js";
import { accountsMatch, addressesMatch } from "./identity.js";
import { safeError } from "./errors.js";

export interface VerificationCheck {
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
}
export interface VerificationResult {
  itemId: string;
  sourceName: string;
  resourceType: string;
  passed: boolean;
  details: string;
  checks: VerificationCheck[];
}

export async function checkTargetItem(
  item: MigrationItem,
  target: ZeroXKeyTargetClient,
): Promise<VerificationCheck[]> {
  if (!["imported", "verified"].includes(item.status) || !item.targetId)
    return [{ name: "imported_target_identity", passed: false }];
  if (item.sourceMetadata.type === "wallet") {
    const wallet = (await target.listWallets()).find(
      (w) => w.walletId === item.targetId,
    );
    if (!wallet) return [{ name: "exists_in_target", passed: false }];
    const accounts = await target.getWalletAccounts(item.targetId);
    return [
      { name: "exists_in_target", passed: true },
      {
        name: "wallet_name_match",
        passed: wallet.walletName === item.sourceName,
      },
      {
        name: "account_identity_match",
        passed: accountsMatch(item.sourceMetadata.accounts, accounts),
      },
    ];
  }
  const key = (await target.listPrivateKeys()).find(
    (k) => k.privateKeyId === item.targetId,
  );
  if (!key) return [{ name: "exists_in_target", passed: false }];
  const meta = item.sourceMetadata;
  return [
    { name: "exists_in_target", passed: true },
    {
      name: "public_key_match",
      passed:
        !!key.publicKey &&
        !!meta.publicKey &&
        key.publicKey.toLowerCase() === meta.publicKey.toLowerCase(),
    },
    { name: "curve_match", passed: key.curve === meta.curve },
    {
      name: "address_identity_match",
      passed: addressesMatch(meta.addresses, key.addresses),
    },
  ];
}

export async function verifyMigration(
  store: ManifestStore,
  target: ZeroXKeyTargetClient,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const item of store.getManifest().items) {
    let checks: VerificationCheck[];
    try {
      checks = await checkTargetItem(item, target);
    } catch (error) {
      checks = [
        {
          name: "target_metadata_available",
          passed: false,
          actual: safeError(error),
        },
      ];
    }
    const passed = checks.every((c) => c.passed);
    results.push({
      itemId: item.id,
      sourceName: item.sourceName,
      resourceType: item.resourceType,
      passed,
      details: passed
        ? "Target identity verified against saved source metadata."
        : "Target identity verification failed.",
      checks,
    });
    if (["imported", "verified"].includes(item.status))
      store.updateStatus(
        item.idempotencyKey,
        passed ? "verified" : "imported",
        { verifiedAt: passed ? new Date().toISOString() : undefined },
      );
  }
  await store.save();
  return results;
}
