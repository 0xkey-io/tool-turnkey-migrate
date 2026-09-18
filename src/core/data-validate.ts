import type { TurnkeySourceClient } from "./source-turnkey.js";
import type { ZeroXKeyTargetClient } from "./target-0xkey.js";
import type { ManifestStore } from "./manifest.js";
import { checkTargetItem } from "./verify.js";
import { accountsMatch, addressesMatch } from "./identity.js";
import { safeError } from "./errors.js";

export interface DataValidationCheck {
  name: string;
  passed: boolean;
  severity: "error" | "warn";
  detail: string;
}
export interface DataValidationRow {
  sourceId: string;
  sourceName: string;
  resourceType: string;
  targetId?: string;
  passed: boolean;
  checks: DataValidationCheck[];
}
export interface DataValidationReport {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  rows: DataValidationRow[];
}

export async function validateMigratedData(
  store: ManifestStore,
  source: TurnkeySourceClient,
  target: ZeroXKeyTargetClient,
): Promise<DataValidationReport> {
  const items = store.getManifest().items;
  const wallets = items.some((i) => i.resourceType === "wallet")
    ? await source.listWallets()
    : [];
  const keys = items.some((i) => i.resourceType === "private_key")
    ? await source.listPrivateKeys()
    : [];
  const rows: DataValidationRow[] = [];
  for (const item of items) {
    const checks: DataValidationCheck[] = [];
    try {
      checks.push(
        ...(await checkTargetItem(item, target)).map((c) => ({
          name: c.name,
          passed: c.passed,
          severity: "error" as const,
          detail: c.passed
            ? "Identity check passed."
            : (c.actual ?? "Identity data is absent or does not match."),
        })),
      );
      const meta = item.sourceMetadata;
      let snapshotMatch = false;
      if (meta.type === "wallet") {
        const live = wallets.find((w) => w.walletId === item.sourceId);
        snapshotMatch =
          !!live &&
          live.walletName === item.sourceName &&
          accountsMatch(meta.accounts, live.accounts);
      } else {
        const live = keys.find((k) => k.privateKeyId === item.sourceId);
        snapshotMatch =
          !!live &&
          live.privateKeyName === item.sourceName &&
          !!live.publicKey &&
          live.publicKey.toLowerCase() === meta.publicKey.toLowerCase() &&
          live.curve === meta.curve &&
          addressesMatch(meta.addresses, live.addresses);
      }
      checks.push({
        name: "live_source_matches_plan",
        passed: snapshotMatch,
        severity: "error",
        detail: snapshotMatch
          ? "Live source identity matches the saved plan."
          : "Live source resource is absent or changed since discovery; reconciliation is required.",
      });
    } catch (error) {
      checks.push({
        name: "metadata_available",
        passed: false,
        severity: "error",
        detail: safeError(error),
      });
    }
    rows.push({
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      resourceType: item.resourceType,
      targetId: item.targetId,
      passed: checks.every((c) => c.passed),
      checks,
    });
  }
  const passed = rows.filter((row) => row.passed).length;
  return {
    total: rows.length,
    passed,
    failed: rows.length - passed,
    warnings: 0,
    rows,
  };
}
