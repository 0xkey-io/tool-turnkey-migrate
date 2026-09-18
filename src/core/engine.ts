import type { MigrationConfig } from "../types/config.js";
import type { MigrationItem, MigrationItemStatus } from "../types/resources.js";
import { ManifestStore, buildIdempotencyKey } from "./manifest.js";
import {
  createTurnkeySourceClient,
  type TurnkeySourceClient,
} from "./source-turnkey.js";
import {
  createZeroXKeyTargetClient,
  importIdentity,
  type ZeroXKeyTargetClient,
} from "./target-0xkey.js";
import {
  generateEphemeralKeyPair,
  bridgeWallet,
  bridgePrivateKey,
} from "./crypto-bridge.js";
import { withRetry } from "./retry.js";
import { pollActivity } from "./activity-poller.js";
import { checkDuplicate } from "./dedup.js";
import {
  validateTransferMetadata,
  accountsMatch,
  addressesMatch,
  addressKey,
} from "./identity.js";
import { RateLimiter } from "./rate-limiter.js";
import { createLogger, type Logger } from "./logger.js";
import { ToolError, safeError } from "./errors.js";

export interface MigrationEngineOptions {
  config: MigrationConfig;
  dryRun?: boolean;
  logger?: Logger;
  onProgress?: (item: MigrationItem, message: string) => void;
  rateLimitRps?: number;
  retryMaxAttempts?: number;
  activityPollMaxWaitMs?: number;
}
export interface MigrationResult {
  imported: number;
  failed: number;
  skipped: number;
  aborted: boolean;
}

const pendingStatuses: MigrationItemStatus[] = [
  "discovered",
  "export_started",
  "exported",
  "target_init_started",
  "target_init_completed",
  "import_started",
  "needs_review",
];

export class MigrationEngine {
  private readonly config: MigrationConfig;
  private readonly dryRun: boolean;
  private readonly log: Logger;
  private readonly onProgress: (item: MigrationItem, message: string) => void;
  private readonly rateLimiter: RateLimiter;
  private readonly retryMaxAttempts: number;
  private readonly activityPollMaxWaitMs: number;
  private readonly store: ManifestStore;
  private source!: TurnkeySourceClient;
  private target!: ZeroXKeyTargetClient;
  private aborted = false;

  constructor(options: MigrationEngineOptions) {
    this.config = options.config;
    this.dryRun = options.dryRun ?? false;
    this.log = options.logger ?? createLogger();
    this.onProgress = options.onProgress ?? (() => {});
    const rps = options.rateLimitRps ?? 5;
    this.rateLimiter = new RateLimiter({
      maxTokens: rps,
      refillRatePerSecond: rps,
    });
    this.retryMaxAttempts = options.retryMaxAttempts ?? 3;
    this.activityPollMaxWaitMs = options.activityPollMaxWaitMs ?? 120_000;
    this.store = new ManifestStore(
      this.config.state.manifestPath,
      this.config.source.organizationId,
      this.config.target.organizationId,
      this.config.target.userId,
      {
        memoryOnly: this.dryRun,
        deployment: {
          sourceApiBaseUrl: this.config.source.apiBaseUrl,
          targetApiBaseUrl: this.config.target.apiBaseUrl,
          targetSignerPublicKey: this.config.target.signerPublicKey,
        },
      },
    );
  }

  async init(requireManifest = false): Promise<void> {
    await this.store.acquireLock();
    try {
      await this.store.load(requireManifest);
      const apiOptions = { beforeRequest: () => this.rateLimiter.acquire() };
      this.source = await createTurnkeySourceClient(
        this.config.source,
        apiOptions,
      );
      this.target = await createZeroXKeyTargetClient(
        this.config.target,
        apiOptions,
      );
    } catch (error) {
      await this.store.releaseLock();
      throw error;
    }
  }
  abort(): void {
    this.aborted = true;
  }
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { maxAttempts: this.retryMaxAttempts });
  }
  private selected(item: MigrationItem): boolean {
    const filter =
      item.resourceType === "wallet"
        ? this.config.resources.wallets
        : this.config.resources.privateKeys;
    return filter === "all" || filter.includes(item.sourceId);
  }

  async discover(allowNewResources = true): Promise<MigrationItem[]> {
    const discovered: MigrationItem[] = [];
    if (
      this.config.resources.wallets === "all" ||
      this.config.resources.wallets.length
    ) {
      const wallets = await this.read(() => this.source.listWallets());
      this.checkSelection(
        wallets.map((w) => w.walletId),
        this.config.resources.wallets,
      );
      for (const w of wallets) {
        const item: MigrationItem = {
          id: w.walletId,
          sourceId: w.walletId,
          sourceName: w.walletName,
          resourceType: "wallet",
          idempotencyKey: buildIdempotencyKey(
            this.config.source.organizationId,
            "wallet",
            w.walletId,
            this.config.target.organizationId,
          ),
          status: "discovered",
          sourceMetadata: { type: "wallet", accounts: w.accounts },
          retryCount: 0,
        };
        if (this.selected(item)) this.discoverItem(item, discovered);
      }
    }
    if (
      this.config.resources.privateKeys === "all" ||
      this.config.resources.privateKeys.length
    ) {
      const keys = await this.read(() => this.source.listPrivateKeys());
      this.checkSelection(
        keys.map((k) => k.privateKeyId),
        this.config.resources.privateKeys,
      );
      for (const k of keys) {
        const item: MigrationItem = {
          id: k.privateKeyId,
          sourceId: k.privateKeyId,
          sourceName: k.privateKeyName,
          resourceType: "private_key",
          idempotencyKey: buildIdempotencyKey(
            this.config.source.organizationId,
            "private_key",
            k.privateKeyId,
            this.config.target.organizationId,
          ),
          status: "discovered",
          sourceMetadata: {
            type: "private_key",
            publicKey: k.publicKey,
            curve: k.curve,
            addresses: k.addresses,
          },
          retryCount: 0,
        };
        if (this.selected(item)) this.discoverItem(item, discovered);
      }
    }
    if (!allowNewResources && discovered.length)
      throw new ToolError(
        "E_PLAN_CHANGED",
        "Source inventory includes resources outside the reviewed plan. Review a fresh plan before execution.",
      );
    for (const item of discovered) this.store.upsertItem(item);
    await this.store.save();
    this.log.info("Source discovery completed", {
      newResources: discovered.length,
    });
    return this.store
      .getManifest()
      .items.filter(
        (item) =>
          this.selected(item) &&
          !["imported", "verified"].includes(item.status),
      );
  }
  private checkSelection(ids: string[], filter: "all" | string[]): void {
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
      throw new ToolError(
        "E_INVENTORY_INVALID",
        "Source inventory contains missing or duplicate resource IDs.",
      );
    if (filter !== "all" && filter.some((id) => !ids.includes(id)))
      throw new ToolError(
        "E_SELECTION_MISSING",
        "One or more explicitly selected resources were not returned by source discovery.",
      );
  }
  private discoverItem(item: MigrationItem, added: MigrationItem[]): void {
    validateTransferMetadata(item);
    const existing = this.store.findItem(item.idempotencyKey);
    if (existing) {
      if (!this.sameSourceIdentity(existing, item))
        throw new ToolError(
          "E_SOURCE_CHANGED",
          "Source metadata changed since the plan. Preserve state and reconcile the change.",
        );
      return;
    }
    added.push(item);
  }
  private sameSourceIdentity(a: MigrationItem, b: MigrationItem): boolean {
    if (
      a.sourceName !== b.sourceName ||
      a.sourceMetadata.type !== b.sourceMetadata.type
    )
      return false;
    if (
      a.sourceMetadata.type === "wallet" &&
      b.sourceMetadata.type === "wallet"
    )
      return accountsMatch(
        a.sourceMetadata.accounts,
        b.sourceMetadata.accounts,
      );
    if (
      a.sourceMetadata.type === "private_key" &&
      b.sourceMetadata.type === "private_key"
    )
      return (
        a.sourceMetadata.publicKey.toLowerCase() ===
          b.sourceMetadata.publicKey.toLowerCase() &&
        a.sourceMetadata.curve === b.sourceMetadata.curve &&
        addressesMatch(a.sourceMetadata.addresses, b.sourceMetadata.addresses)
      );
    return false;
  }

  async migrateAll(): Promise<MigrationResult> {
    const pending = this.store
      .getItemsWithStatus(...pendingStatuses)
      .filter((item) => this.selected(item));
    const result: MigrationResult = {
      imported: 0,
      failed: 0,
      skipped: 0,
      aborted: false,
    };
    if (this.dryRun) {
      await this.read(() => this.target.listPrivateKeys());
      for (const w of await this.read(() => this.target.listWallets()))
        await this.read(() => this.target.getWalletAccounts(w.walletId));
      for (const item of pending) {
        if (this.aborted) break;
        validateTransferMetadata(item);
        const duplicate = await checkDuplicate(item, this.target);
        if (
          duplicate.conflict ||
          item.status === "needs_review" ||
          item.status === "import_started"
        )
          result.failed++;
        else result.skipped++;
        this.onProgress(
          item,
          "Read-only preflight; export/import authorization has not been exercised.",
        );
      }
      result.aborted = this.aborted;
      return result;
    }
    // Unavailable identity inventory must block new submissions, not disable checks.
    if (
      pending.some(
        (item) =>
          item.status !== "needs_review" && item.status !== "import_started",
      )
    )
      await this.read(() => this.target.listPrivateKeys());
    for (const item of pending) {
      if (this.aborted) break;
      try {
        validateTransferMetadata(item);
        if (
          item.status === "needs_review" ||
          item.status === "import_started"
        ) {
          if (!item.importActivityId)
            throw new ToolError(
              "E_IMPORT_REVIEW",
              "Import outcome is unknown and no activity ID is recorded. Manual reconciliation is required.",
            );
          await this.reconcile(item);
          result.imported++;
          continue;
        }
        const duplicate = await checkDuplicate(item, this.target);
        if (duplicate.conflict) {
          item.status = "needs_review";
          throw new ToolError(
            "E_TARGET_CONFLICT",
            "Target resource overlap is not a complete unique identity. Manual review is required.",
          );
        }
        if (duplicate.isDuplicate && duplicate.targetId) {
          this.store.updateStatus(item.idempotencyKey, "imported", {
            targetId: duplicate.targetId,
            error: undefined,
          });
          await this.store.save();
          result.skipped++;
          this.onProgress(
            item,
            "Matching target identity recorded; run verification before acceptance.",
          );
          continue;
        }
        await this.transfer(item);
        result.imported++;
      } catch (error) {
        const review =
          item.status === "import_started" || item.status === "needs_review";
        item.status = review ? "needs_review" : "failed";
        item.error = review
          ? "E_IMPORT_REVIEW: Reconcile the target activity/resource before any further submission."
          : safeError(error);
        item.retryCount++;
        this.store.upsertItem(item);
        await this.store.save();
        this.log.error("Resource transfer did not complete", {
          sourceId: item.sourceId,
          code: item.error.split(":")[0],
          reviewRequired: review,
        });
        this.onProgress(item, item.error);
        result.failed++;
      }
    }
    result.aborted = this.aborted;
    return result;
  }

  async resetFailed(): Promise<void> {
    for (const item of this.store
      .getItemsWithStatus("failed")
      .filter((i) => this.selected(i))) {
      // A legacy failed item carrying any import trace is not safe to retry.
      if (item.importActivityId || item.targetId)
        this.store.updateStatus(item.idempotencyKey, "needs_review");
      else
        this.store.updateStatus(item.idempotencyKey, "discovered", {
          error: undefined,
        });
    }
    await this.store.save();
  }
  async finish(): Promise<void> {
    try {
      await this.store.save();
    } finally {
      await this.store.releaseLock();
    }
  }
  getManifest() {
    return this.store.getManifest();
  }
  getStore() {
    return this.store;
  }

  private async transition(
    item: MigrationItem,
    status: MigrationItemStatus,
  ): Promise<void> {
    this.store.updateStatus(item.idempotencyKey, status);
    await this.store.save();
  }
  private async transfer(item: MigrationItem): Promise<void> {
    const ephemeral = await generateEphemeralKeyPair();
    try {
      await this.transition(item, "export_started");
      this.onProgress(item, "Exporting selected resource from Turnkey.");
      // Export/init are also single-attempt; resume starts a new ephemeral session if needed.
      const exported =
        item.resourceType === "wallet"
          ? await this.source.exportWallet(
              item.sourceId,
              ephemeral.publicKeyUncompressed,
            )
          : await this.source.exportPrivateKey(
              item.sourceId,
              ephemeral.publicKeyUncompressed,
            );
      await this.transition(item, "exported");
      await this.transition(item, "target_init_started");
      const initialized =
        item.resourceType === "wallet"
          ? await this.target.initImportWallet()
          : await this.target.initImportPrivateKey();
      this.store.updateStatus(item.idempotencyKey, "target_init_completed", {
        initActivityId: initialized.activityId,
      });
      await this.store.save();
      const params = {
        turnkeyExportBundle: exported.exportBundle,
        ephemeralPrivateKey: ephemeral.privateKey,
        turnkeyOrganizationId: this.config.source.organizationId,
        zeroxkeyImportBundle: initialized.importBundle,
        zeroxkeyUserId: this.config.target.userId,
        zeroxkeyOrganizationId: this.config.target.organizationId,
        zeroxkeySignerPublicKey: this.config.target.signerPublicKey,
      };
      const meta = item.sourceMetadata;
      const bridged =
        meta.type === "wallet"
          ? await bridgeWallet(params)
          : await bridgePrivateKey({
              ...params,
              keyFormat:
                meta.curve === "CURVE_ED25519" ? "SOLANA" : "HEXADECIMAL",
            });
      // Durable submission intent comes before the API call. Never retry this call.
      await this.transition(item, "import_started");
      const imported =
        meta.type === "wallet"
          ? await this.target.importWallet({
              walletName: item.sourceName,
              encryptedBundle: bridged.encryptedBundle,
              accounts: meta.accounts,
            })
          : await this.target.importPrivateKey({
              privateKeyName: item.sourceName,
              encryptedBundle: bridged.encryptedBundle,
              curve: meta.curve,
              addressFormats: [...new Set(meta.addresses.map((a) => a.format))],
            });
      this.store.updateStatus(item.idempotencyKey, "import_started", {
        importActivityId: imported.activityId,
      });
      await this.store.save();
      await this.reconcile(item);
    } finally {
      ephemeral.privateKey.zero();
    }
  }
  private async reconcile(item: MigrationItem): Promise<void> {
    if (!item.importActivityId)
      throw new ToolError(
        "E_IMPORT_REVIEW",
        "No activity ID is available for reconciliation.",
      );
    const type =
      item.resourceType === "wallet"
        ? "ACTIVITY_TYPE_IMPORT_WALLET"
        : "ACTIVITY_TYPE_IMPORT_PRIVATE_KEY";
    const completed = await pollActivity(
      {
        getActivity: (id) => this.read(() => this.target.getActivity(id, type)),
      },
      item.importActivityId,
      { maxWaitMs: this.activityPollMaxWaitMs },
    );
    const identity = importIdentity(completed.result, item.resourceType);
    // Record the destination before any identity mismatch is surfaced.
    this.store.updateStatus(item.idempotencyKey, "import_started", identity);
    await this.store.save();
    const addresses =
      item.sourceMetadata.type === "wallet"
        ? item.sourceMetadata.accounts.map((a) => ({
            format: a.addressFormat,
            address: a.address ?? "",
          }))
        : item.sourceMetadata.addresses;
    if (
      addresses.length !== identity.targetAddresses.length ||
      addresses.some(
        (a) =>
          !identity.targetAddresses.some(
            (b) => addressKey(a.format, a.address) === addressKey(a.format, b),
          ),
      )
    ) {
      throw new ToolError(
        "E_IMPORT_IDENTITY",
        "Completed import addresses do not match the planned source. Manual reconciliation is required.",
      );
    }
    this.store.updateStatus(item.idempotencyKey, "imported", {
      ...identity,
      error: undefined,
    });
    await this.store.save();
    this.onProgress(
      item,
      "Target identity recorded; verify before acceptance.",
    );
  }
}
