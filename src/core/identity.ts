import type {
  WalletAccountSpec,
  SourcePrivateKeyMetadata,
  MigrationItem,
} from "../types/resources.js";
import type { TargetPrivateKey } from "./target-0xkey.js";
import type { ZeroXKeyApiTypes } from "@0xkey-io/sdk-server";
import { ToolError } from "./errors.js";

const supportedFormats = [
  "ADDRESS_FORMAT_UNCOMPRESSED",
  "ADDRESS_FORMAT_COMPRESSED",
  "ADDRESS_FORMAT_ETHEREUM",
  "ADDRESS_FORMAT_SOLANA",
  "ADDRESS_FORMAT_COSMOS",
  "ADDRESS_FORMAT_TRON",
  "ADDRESS_FORMAT_SUI",
  "ADDRESS_FORMAT_APTOS",
  "ADDRESS_FORMAT_BITCOIN_MAINNET_P2PKH",
  "ADDRESS_FORMAT_BITCOIN_MAINNET_P2SH",
  "ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH",
  "ADDRESS_FORMAT_BITCOIN_MAINNET_P2WSH",
  "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR",
  "ADDRESS_FORMAT_BITCOIN_TESTNET_P2PKH",
  "ADDRESS_FORMAT_BITCOIN_TESTNET_P2SH",
  "ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH",
  "ADDRESS_FORMAT_BITCOIN_TESTNET_P2WSH",
  "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR",
  "ADDRESS_FORMAT_BITCOIN_SIGNET_P2PKH",
  "ADDRESS_FORMAT_BITCOIN_SIGNET_P2SH",
  "ADDRESS_FORMAT_BITCOIN_SIGNET_P2WPKH",
  "ADDRESS_FORMAT_BITCOIN_SIGNET_P2WSH",
  "ADDRESS_FORMAT_BITCOIN_SIGNET_P2TR",
  "ADDRESS_FORMAT_BITCOIN_REGTEST_P2PKH",
  "ADDRESS_FORMAT_BITCOIN_REGTEST_P2SH",
  "ADDRESS_FORMAT_BITCOIN_REGTEST_P2WPKH",
  "ADDRESS_FORMAT_BITCOIN_REGTEST_P2WSH",
  "ADDRESS_FORMAT_BITCOIN_REGTEST_P2TR",
  "ADDRESS_FORMAT_SEI",
  "ADDRESS_FORMAT_XLM",
  "ADDRESS_FORMAT_DOGE_MAINNET",
  "ADDRESS_FORMAT_DOGE_TESTNET",
  "ADDRESS_FORMAT_TON_V3R2",
  "ADDRESS_FORMAT_TON_V4R2",
  "ADDRESS_FORMAT_TON_V5R1",
  "ADDRESS_FORMAT_XRP",
] satisfies ZeroXKeyApiTypes["v1AddressFormat"][];

export function addressKey(format: string, address?: string): string {
  if (!format || !address) return "";
  const normalized =
    [
      "ADDRESS_FORMAT_ETHEREUM",
      "ADDRESS_FORMAT_UNCOMPRESSED",
      "ADDRESS_FORMAT_COMPRESSED",
      "ADDRESS_FORMAT_SUI",
      "ADDRESS_FORMAT_APTOS",
    ].includes(format) && /^(?:0x)?[0-9a-f]+$/i.test(address)
      ? address.toLowerCase()
      : address;
  return JSON.stringify([format, normalized]);
}
export function accountKey(a: WalletAccountSpec): string {
  const address = addressKey(a.addressFormat, a.address);
  if (!a.curve || !a.pathFormat || !a.path || !address) return "";
  return JSON.stringify([a.curve, a.pathFormat, a.path, address]);
}
function sameSet(a: string[], b: string[]): boolean {
  const source = new Set(a);
  const target = new Set(b);
  return (
    a.length > 0 &&
    a.every(Boolean) &&
    b.every(Boolean) &&
    source.size === a.length &&
    target.size === b.length &&
    source.size === target.size &&
    [...source].every((entry) => target.has(entry))
  );
}
export function accountsMatch(
  a: WalletAccountSpec[],
  b: WalletAccountSpec[],
): boolean {
  return sameSet(a.map(accountKey), b.map(accountKey));
}
export function addressesMatch(
  a: Array<{ format: string; address: string }>,
  b: Array<{ format: string; address: string }>,
): boolean {
  return sameSet(
    a.map((entry) => addressKey(entry.format, entry.address)),
    b.map((entry) => addressKey(entry.format, entry.address)),
  );
}
export function privateKeyMatch(
  source: SourcePrivateKeyMetadata,
  target: TargetPrivateKey,
): boolean {
  return (
    !!source.publicKey &&
    !!target.publicKey &&
    source.publicKey.toLowerCase() === target.publicKey.toLowerCase() &&
    source.curve === target.curve &&
    addressesMatch(source.addresses, target.addresses)
  );
}
export function validateTransferMetadata(item: MigrationItem): void {
  const meta = item.sourceMetadata;
  const curveOK = (curve: string) =>
    ["CURVE_SECP256K1", "CURVE_ED25519"].includes(curve);
  const formatOK = (format: string) =>
    supportedFormats.includes(format as ZeroXKeyApiTypes["v1AddressFormat"]);
  if (meta.type === "wallet") {
    if (
      !meta.accounts.length ||
      !accountsMatch(meta.accounts, meta.accounts) ||
      meta.accounts.some(
        (a) =>
          !curveOK(a.curve) ||
          a.pathFormat !== "PATH_FORMAT_BIP32" ||
          !/^m(?:\/[0-9]+'?)+$/.test(a.path) ||
          !formatOK(a.addressFormat),
      )
    ) {
      throw new ToolError(
        "E_METADATA_UNSUPPORTED",
        "Wallet accounts are missing, inconsistent, or use unsupported derivation/curve/address metadata.",
      );
    }
  } else {
    if (
      !curveOK(meta.curve) ||
      !formatOK(meta.addresses[0]?.format ?? "") ||
      !addressesMatch(meta.addresses, meta.addresses) ||
      meta.addresses.some((a) => !formatOK(a.format)) ||
      !/^(?:0x)?[0-9a-f]+$/i.test(meta.publicKey)
    ) {
      throw new ToolError(
        "E_METADATA_UNSUPPORTED",
        "Private key metadata is incomplete or uses an unsupported curve/address format.",
      );
    }
  }
}
