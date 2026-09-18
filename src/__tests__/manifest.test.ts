import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ManifestStore, buildIdempotencyKey } from "../core/manifest.js";
import {
  unlink,
  writeFile,
  readFile,
  stat,
  symlink,
  mkdtemp,
  rm,
  chmod,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_PATH = join(
  process.platform === "darwin" ? "/private/tmp" : tmpdir(),
  `test-manifest-${Date.now()}.json`,
);
let LOCK_PATH = `${TEST_PATH}.lock`;
let directory: string;

describe("ManifestStore", () => {
  let store: ManifestStore;
  let originalToken: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(
        process.platform === "darwin" ? "/private/tmp" : tmpdir(),
        "manifest-fixture-",
      ),
    );
    TEST_PATH = join(directory, "manifest.json");
    LOCK_PATH = `${TEST_PATH}.lock`;
    store = new ManifestStore(TEST_PATH, "tk-org-1", "0xkey-org-1", "user-1");
    await store.acquireLock();
    originalToken = await readFile(LOCK_PATH, "utf8");
  });

  afterEach(async () => {
    await store.releaseLock();
    await rm(directory, { recursive: true, force: true });
    try {
      await unlink(TEST_PATH);
    } catch {}
    try {
      await unlink(LOCK_PATH);
    } catch {}
  });

  it("refuses a state directory accessible to other users", async () => {
    await store.releaseLock();
    await chmod(directory, 0o755);
    await expect(store.acquireLock()).rejects.toThrow(/private|permission/i);
  });

  it("preserves a replaced regular state file", async () => {
    await store.save();
    const replacement = `${TEST_PATH}.replacement`;
    await writeFile(replacement, "externally replaced");
    await rename(replacement, TEST_PATH);
    await expect(store.save()).rejects.toThrow(/changed/i);
    expect(await readFile(TEST_PATH, "utf8")).toBe("externally replaced");
  });

  it("refuses a parent replaced with a symlink", async () => {
    const moved = `${directory}.moved`;
    await rename(directory, moved);
    await symlink(moved, directory);
    try {
      await expect(store.save()).rejects.toThrow(/symbolic|symlink/i);
    } finally {
      await unlink(directory);
      await rename(moved, directory);
    }
  });

  it("preserves a lock replaced by a different owner token", async () => {
    await writeFile(LOCK_PATH, "another-owner");
    await expect(store.releaseLock()).rejects.toThrow(/ownership/i);
    expect(await readFile(LOCK_PATH, "utf8")).toBe("another-owner");
    // Restore only our fixture token so teardown can exercise normal ownership.
    await writeFile(LOCK_PATH, originalToken);
  });

  it("should create and save a manifest", async () => {
    await store.save();
    const manifest = store.getManifest();
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.sourceOrgId).toBe("tk-org-1");
    expect(manifest.targetOrgId).toBe("0xkey-org-1");
  });

  it("should upsert and find items by idempotency key", () => {
    const key = buildIdempotencyKey(
      "tk-org-1",
      "wallet",
      "w-123",
      "0xkey-org-1",
    );
    store.upsertItem({
      id: "w-123",
      idempotencyKey: key,
      resourceType: "wallet",
      sourceId: "w-123",
      sourceName: "My Wallet",
      status: "discovered",
      sourceMetadata: { type: "wallet", accounts: [] },
      retryCount: 0,
    });

    const found = store.findItem(key);
    expect(found).toBeDefined();
    expect(found!.sourceId).toBe("w-123");
    expect(found!.status).toBe("discovered");
  });

  it("should detect already-imported items", () => {
    const key = buildIdempotencyKey(
      "tk-org-1",
      "wallet",
      "w-456",
      "0xkey-org-1",
    );
    store.upsertItem({
      id: "w-456",
      idempotencyKey: key,
      resourceType: "wallet",
      sourceId: "w-456",
      sourceName: "Imported Wallet",
      status: "imported",
      sourceMetadata: { type: "wallet", accounts: [] },
      targetId: "target-w-1",
      retryCount: 0,
    });

    expect(store.isAlreadyImported(key)).toBe(true);
  });

  it("should not treat discovered items as imported", () => {
    const key = buildIdempotencyKey(
      "tk-org-1",
      "private_key",
      "pk-1",
      "0xkey-org-1",
    );
    store.upsertItem({
      id: "pk-1",
      idempotencyKey: key,
      resourceType: "private_key",
      sourceId: "pk-1",
      sourceName: "Key 1",
      status: "discovered",
      sourceMetadata: {
        type: "private_key",
        publicKey: "0x...",
        curve: "CURVE_SECP256K1",
        addresses: [],
      },
      retryCount: 0,
    });

    expect(store.isAlreadyImported(key)).toBe(false);
  });

  it("should update status with extra fields", () => {
    const key = buildIdempotencyKey(
      "tk-org-1",
      "wallet",
      "w-789",
      "0xkey-org-1",
    );
    store.upsertItem({
      id: "w-789",
      idempotencyKey: key,
      resourceType: "wallet",
      sourceId: "w-789",
      sourceName: "Test",
      status: "discovered",
      sourceMetadata: { type: "wallet", accounts: [] },
      retryCount: 0,
    });

    store.updateStatus(key, "imported", {
      targetId: "target-123",
      targetAddresses: ["0xabc"],
    });
    const item = store.findItem(key)!;
    expect(item.status).toBe("imported");
    expect(item.targetId).toBe("target-123");
    expect(item.targetAddresses).toEqual(["0xabc"]);
  });

  it("should persist and reload", async () => {
    const key = buildIdempotencyKey(
      "tk-org-1",
      "wallet",
      "w-persist",
      "0xkey-org-1",
    );
    store.upsertItem({
      id: "w-persist",
      idempotencyKey: key,
      resourceType: "wallet",
      sourceId: "w-persist",
      sourceName: "Persist Test",
      status: "imported",
      sourceMetadata: { type: "wallet", accounts: [] },
      retryCount: 0,
    });
    await store.save();

    const store2 = new ManifestStore(
      TEST_PATH,
      "tk-org-1",
      "0xkey-org-1",
      "user-1",
    );
    await store2.load();
    expect(store2.isAlreadyImported(key)).toBe(true);
  });

  it("should prevent concurrent lock acquisition", async () => {
    const store2 = new ManifestStore(
      TEST_PATH,
      "tk-org-1",
      "0xkey-org-1",
      "user-1",
    );
    await expect(store2.acquireLock()).rejects.toThrow(/already in progress/);
  });

  it("refuses a manifest belonging to another target organization", async () => {
    await store.save();
    const other = new ManifestStore(
      TEST_PATH,
      "tk-org-1",
      "other-org",
      "user-1",
    );
    await expect(other.load()).rejects.toThrow(/context|organization/i);
  });

  it("does not let a non-owner remove the migration lock", async () => {
    const other = new ManifestStore(
      TEST_PATH,
      "tk-org-1",
      "0xkey-org-1",
      "user-1",
    );
    await other.releaseLock();
    await expect(other.acquireLock()).rejects.toThrow();
  });

  it("restricts state file permissions", async () => {
    await store.save();
    expect((await stat(TEST_PATH)).mode & 0o777).toBe(0o600);
  });

  it("refuses to write through a manifest symlink", async () => {
    const victim = `${TEST_PATH}.victim`;
    await writeFile(victim, "unchanged");
    await symlink(victim, TEST_PATH);
    try {
      await expect(store.save()).rejects.toThrow(/symbolic|symlink/i);
      expect(await readFile(victim, "utf8")).toBe("unchanged");
    } finally {
      await unlink(victim);
    }
  });

  it("refuses unsupported manifest versions", async () => {
    await writeFile(
      TEST_PATH,
      JSON.stringify({ ...store.getManifest(), version: "99.0.0" }),
    );
    await expect(store.load()).rejects.toThrow(/version|invalid/i);
  });

  it("allows only one winner when locks are acquired concurrently", async () => {
    await store.releaseLock();
    const other = new ManifestStore(
      TEST_PATH,
      "tk-org-1",
      "0xkey-org-1",
      "user-1",
    );
    const results = await Promise.allSettled([
      store.acquireLock(),
      other.acquireLock(),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await other.releaseLock();
  });
});

describe("buildIdempotencyKey", () => {
  it("should produce a deterministic key", () => {
    const key = buildIdempotencyKey("org-a", "wallet", "w-1", "org-b");
    expect(key).toBe("turnkey:org-a:wallet:w-1:org-b");
  });
});
