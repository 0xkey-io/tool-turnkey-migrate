import { open, rename, unlink, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { MigrationManifest, MigrationSummary } from "../types/manifest.js";
import type { MigrationItem, MigrationItemStatus } from "../types/resources.js";
import { buildIdempotencyKey } from "../types/manifest.js";
import {
  assertSafePath,
  hasCode,
  readSafeText,
  privateStateDirectory,
} from "./safe-files.js";
import { ToolError } from "./errors.js";

export interface DeploymentContext {
  sourceApiBaseUrl: string;
  targetApiBaseUrl: string;
  targetSignerPublicKey: string;
}
export interface ManifestOptions {
  memoryOnly?: boolean;
  deployment?: DeploymentContext;
}

const statuses: MigrationItemStatus[] = [
  "discovered",
  "export_started",
  "exported",
  "target_init_started",
  "target_init_completed",
  "import_started",
  "imported",
  "verified",
  "failed",
  "skipped",
  "needs_review",
];
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isText(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function invalid(): never {
  throw new ToolError(
    "E_MANIFEST_INVALID",
    "Invalid manifest schema or unsupported version. Preserve the file and reconcile it before continuing.",
  );
}
function fields(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some((k) => !allowed.includes(k))) invalid();
}

function validateItem(v: unknown): asserts v is MigrationItem {
  if (!isRecord(v)) invalid();
  fields(v, [
    "id",
    "idempotencyKey",
    "resourceType",
    "sourceId",
    "sourceName",
    "status",
    "sourceMetadata",
    "targetId",
    "targetAddresses",
    "initActivityId",
    "importActivityId",
    "error",
    "retryCount",
    "verifiedAt",
  ]);
  for (const name of ["id", "idempotencyKey", "sourceId", "sourceName"])
    if (!isText(v[name])) invalid();
  if (v.resourceType !== "wallet" && v.resourceType !== "private_key")
    invalid();
  if (
    !statuses.includes(v.status as MigrationItemStatus) ||
    !Number.isSafeInteger(v.retryCount) ||
    Number(v.retryCount) < 0
  )
    invalid();
  for (const name of [
    "targetId",
    "initActivityId",
    "importActivityId",
    "error",
    "verifiedAt",
  ])
    if (v[name] !== undefined && !isText(v[name])) invalid();
  if (v.error !== undefined && !/^E_[A-Z_]+(?::|$)/.test(String(v.error)))
    invalid();
  if (
    v.targetAddresses !== undefined &&
    !(Array.isArray(v.targetAddresses) && v.targetAddresses.every(isText))
  )
    invalid();
  const meta = v.sourceMetadata;
  if (!isRecord(meta) || meta.type !== v.resourceType) invalid();
  if (meta.type === "wallet") {
    fields(meta, ["type", "accounts"]);
    if (!Array.isArray(meta.accounts)) invalid();
    for (const a of meta.accounts) {
      if (!isRecord(a)) invalid();
      fields(a, ["curve", "pathFormat", "path", "addressFormat", "address"]);
      for (const name of ["curve", "pathFormat", "path", "addressFormat"])
        if (!isText(a[name])) invalid();
      if (a.address !== undefined && !isText(a.address)) invalid();
    }
  } else {
    fields(meta, ["type", "publicKey", "curve", "addresses"]);
    if (
      !isText(meta.publicKey) ||
      !isText(meta.curve) ||
      !Array.isArray(meta.addresses)
    )
      invalid();
    for (const a of meta.addresses) {
      if (!isRecord(a)) invalid();
      fields(a, ["format", "address"]);
      if (!isText(a.format) || !isText(a.address)) invalid();
    }
  }
}

export class ManifestStore {
  private manifest: MigrationManifest;
  private readonly lockPath: string;
  private lockToken?: string;
  private identity?: { ino: number; dev: number };
  private readonly expected: {
    sourceOrgId: string;
    targetOrgId: string;
    targetUserId: string;
  };

  constructor(
    private readonly filePath: string,
    sourceOrgId: string,
    targetOrgId: string,
    targetUserId: string,
    private readonly options: ManifestOptions = {},
  ) {
    this.lockPath = `${filePath}.lock`;
    this.expected = { sourceOrgId, targetOrgId, targetUserId };
    this.manifest = {
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceProvider: "turnkey",
      sourceOrgId,
      targetProvider: "0xkey",
      targetOrgId,
      targetUserId,
      ...(options.deployment ? { deployment: options.deployment } : {}),
      items: [],
      summary: {
        total: 0,
        discovered: 0,
        imported: 0,
        verified: 0,
        failed: 0,
        skipped: 0,
        needsReview: 0,
      },
    };
  }

  private directoryIdentity?: { ino: number; dev: number };
  private async checkDirectory(): Promise<void> {
    const current = await privateStateDirectory(this.filePath);
    if (
      this.directoryIdentity &&
      (current.ino !== this.directoryIdentity.ino ||
        current.dev !== this.directoryIdentity.dev)
    )
      throw new ToolError(
        "E_STATE_CHANGED",
        "Private state directory changed; refusing filesystem operations.",
      );
    this.directoryIdentity = current;
  }
  private async checkStateIdentity(): Promise<void> {
    await this.checkDirectory();
    try {
      const current = await lstat(this.filePath);
      if (
        !this.identity ||
        current.ino !== this.identity.ino ||
        current.dev !== this.identity.dev
      )
        throw new ToolError(
          "E_STATE_CHANGED",
          "State file changed outside this process; refusing to overwrite it.",
        );
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (this.identity)
        throw new ToolError(
          "E_STATE_CHANGED",
          "Loaded state file disappeared.",
        );
    }
  }

  async acquireLock(): Promise<void> {
    if (this.options.memoryOnly) return;
    if (this.lockToken)
      throw new ToolError(
        "E_LOCKED",
        "Migration already in progress in this store.",
      );
    await this.checkDirectory();
    await assertSafePath(this.lockPath, true);
    const token = `${process.pid}:${randomUUID()}`;
    try {
      const handle = await open(
        this.lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(token, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.lockToken = token;
    } catch (error) {
      if (hasCode(error, "EEXIST"))
        throw new ToolError(
          "E_LOCKED",
          "Migration already in progress. Confirm no process is active before an operator removes a stale lock.",
        );
      throw error;
    }
  }

  async releaseLock(): Promise<void> {
    if (!this.lockToken) return;
    await this.checkDirectory();
    if ((await readSafeText(this.lockPath)) !== this.lockToken)
      throw new ToolError(
        "E_LOCK_CHANGED",
        "Lock ownership changed; refusing to remove it.",
      );
    await unlink(this.lockPath);
    this.lockToken = undefined;
  }

  async load(required = false): Promise<void> {
    if (!this.options.memoryOnly) await this.checkDirectory();
    try {
      const raw = await readSafeText(this.filePath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        invalid();
      }
      this.validate(parsed);
      this.manifest = parsed;
      const info = await lstat(this.filePath);
      this.identity = { ino: info.ino, dev: info.dev };
    } catch (error) {
      if (!required && hasCode(error, "ENOENT")) return;
      if (hasCode(error, "ENOENT"))
        throw new ToolError(
          "E_MANIFEST_MISSING",
          "The requested manifest does not exist. Run plan first.",
        );
      throw error;
    }
  }

  private validate(v: unknown): asserts v is MigrationManifest {
    if (!isRecord(v)) invalid();
    fields(v, [
      "version",
      "createdAt",
      "updatedAt",
      "sourceProvider",
      "sourceOrgId",
      "targetProvider",
      "targetOrgId",
      "targetUserId",
      "deployment",
      "items",
      "summary",
    ]);
    if (
      v.version !== "1.0.0" ||
      v.sourceProvider !== "turnkey" ||
      v.targetProvider !== "0xkey"
    )
      invalid();
    for (const name of ["createdAt", "updatedAt"])
      if (!isText(v[name]) || !Number.isFinite(Date.parse(String(v[name]))))
        invalid();
    if (Object.entries(this.expected).some(([k, value]) => v[k] !== value))
      throw new ToolError(
        "E_MANIFEST_CONTEXT",
        "Manifest organization/user context does not match this configuration.",
      );
    const deployment = v.deployment;
    if (
      this.options.deployment &&
      (!isRecord(deployment) ||
        Object.entries(this.options.deployment).some(
          ([key, value]) => deployment[key] !== value,
        ))
    )
      throw new ToolError(
        "E_MANIFEST_CONTEXT",
        "Manifest endpoint/signer context does not match this configuration. Legacy manifests require manual reconciliation.",
      );
    if (v.deployment !== undefined) {
      if (!isRecord(v.deployment)) invalid();
      fields(v.deployment, [
        "sourceApiBaseUrl",
        "targetApiBaseUrl",
        "targetSignerPublicKey",
      ]);
      if (Object.values(v.deployment).some((entry) => !isText(entry)))
        invalid();
    }
    if (!Array.isArray(v.items) || !isRecord(v.summary)) invalid();
    const seen = new Set<string>();
    for (const item of v.items) {
      validateItem(item);
      if (
        item.id !== item.sourceId ||
        item.idempotencyKey !==
          buildIdempotencyKey(
            this.expected.sourceOrgId,
            item.resourceType,
            item.sourceId,
            this.expected.targetOrgId,
          ) ||
        seen.has(item.idempotencyKey)
      )
        invalid();
      seen.add(item.idempotencyKey);
    }
  }

  async save(): Promise<void> {
    this.manifest.summary = this.computeSummary();
    if (this.options.memoryOnly) return;
    if (!this.lockToken)
      throw new ToolError(
        "E_LOCK_REQUIRED",
        "State writes require ownership of the migration lock.",
      );
    this.validate(this.manifest);
    if ((await readSafeText(this.lockPath)) !== this.lockToken)
      throw new ToolError("E_LOCK_CHANGED", "State lock ownership changed.");
    await assertSafePath(this.filePath, true);
    try {
      const info = await lstat(this.filePath);
      if (
        !this.identity ||
        info.ino !== this.identity.ino ||
        info.dev !== this.identity.dev
      )
        throw new ToolError(
          "E_STATE_CHANGED",
          "State file changed outside this process; refusing to overwrite it.",
        );
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (this.identity)
        throw new ToolError(
          "E_STATE_CHANGED",
          "Loaded state file disappeared.",
        );
    }
    this.manifest.updatedAt = new Date().toISOString();
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const handle = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      try {
        await handle.writeFile(
          JSON.stringify(this.manifest, null, 2) + "\n",
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertSafePath(this.filePath, true);
      await this.checkStateIdentity();
      await rename(temporary, this.filePath);
      const info = await lstat(this.filePath);
      this.identity = { ino: info.ino, dev: info.dev };
      if (process.platform !== "win32") {
        const directory = await open(
          dirname(this.filePath),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      if (created)
        await unlink(temporary).catch((error: unknown) => {
          if (!hasCode(error, "ENOENT")) throw error;
        });
    }
  }

  getManifest(): MigrationManifest {
    this.manifest.summary = this.computeSummary();
    return this.manifest;
  }
  findItem(key: string): MigrationItem | undefined {
    return this.manifest.items.find((item) => item.idempotencyKey === key);
  }
  upsertItem(item: MigrationItem): void {
    validateItem(item);
    const index = this.manifest.items.findIndex(
      (existing) => existing.idempotencyKey === item.idempotencyKey,
    );
    if (index < 0) this.manifest.items.push(item);
    else this.manifest.items[index] = item;
  }
  updateStatus(
    key: string,
    status: MigrationItemStatus,
    extra?: Partial<MigrationItem>,
  ): void {
    const item = this.findItem(key);
    if (!item)
      throw new ToolError("E_ITEM_MISSING", "Manifest resource was not found.");
    Object.assign(item, extra, { status });
  }
  getItemsWithStatus(...selected: MigrationItemStatus[]): MigrationItem[] {
    return this.manifest.items.filter((item) => selected.includes(item.status));
  }
  isAlreadyImported(key: string): boolean {
    return ["imported", "verified"].includes(this.findItem(key)?.status ?? "");
  }
  private computeSummary(): MigrationSummary {
    const items = this.manifest.items;
    const count = (status: MigrationItemStatus) =>
      items.filter((item) => item.status === status).length;
    return {
      total: items.length,
      discovered: count("discovered"),
      imported: count("imported"),
      verified: count("verified"),
      failed: count("failed"),
      skipped: count("skipped"),
      needsReview: count("needs_review"),
    };
  }
}
export { buildIdempotencyKey };
