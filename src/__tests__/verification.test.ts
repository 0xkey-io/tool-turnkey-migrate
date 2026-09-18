import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ManifestStore } from "../core/manifest.js";
import { verifyMigration } from "../core/verify.js";
import { validateMigratedData } from "../core/data-validate.js";
import type { ZeroXKeyTargetClient } from "../core/target-0xkey.js";
import type { TurnkeySourceClient } from "../core/source-turnkey.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const account = {
  curve: "CURVE_ED25519",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/44'/501'/0'/0'",
  addressFormat: "ADDRESS_FORMAT_SOLANA",
  address: "AbC123",
};

describe("verification fails closed", () => {
  let dir: string;
  let store: ManifestStore;
  let target: ZeroXKeyTargetClient;
  let source: TurnkeySourceClient;

  beforeEach(async () => {
    dir = await mkdtemp(
      join(
        process.platform === "darwin" ? "/private/tmp" : tmpdir(),
        "migration-verification-",
      ),
    );
    store = new ManifestStore(
      join(dir, "manifest.json"),
      "source",
      "target",
      "user",
    );
    await store.acquireLock();
    store.upsertItem({
      id: "w1",
      idempotencyKey: "turnkey:source:wallet:w1:target",
      resourceType: "wallet",
      sourceId: "w1",
      sourceName: "Wallet",
      status: "imported",
      sourceMetadata: { type: "wallet", accounts: [account] },
      targetId: "tw1",
      retryCount: 0,
    });
    target = {
      listWallets: vi.fn().mockResolvedValue([
        {
          walletId: "tw1",
          walletName: "Wallet",
          imported: true,
          exported: false,
        },
      ]),
      getWalletAccounts: vi.fn().mockResolvedValue([account]),
      listPrivateKeys: vi.fn().mockResolvedValue([]),
      initImportWallet: vi.fn(),
      importWallet: vi.fn(),
      initImportPrivateKey: vi.fn(),
      importPrivateKey: vi.fn(),
      getActivity: vi.fn(),
    };
    source = {
      listWallets: vi.fn().mockResolvedValue([
        {
          walletId: "w1",
          walletName: "Wallet",
          accounts: [account],
          imported: false,
          exported: false,
        },
      ]),
      listPrivateKeys: vi.fn().mockResolvedValue([]),
      exportWallet: vi.fn(),
      exportWalletAccount: vi.fn(),
      exportPrivateKey: vi.fn(),
    };
  });
  afterEach(async () => {
    await store.releaseLock();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects case changes in Solana addresses", async () => {
    vi.mocked(target.getWalletAccounts).mockResolvedValue([
      { ...account, address: "abc123" },
    ]);
    expect((await verifyMigration(store, target))[0].passed).toBe(false);
    expect((await validateMigratedData(store, source, target)).failed).toBe(1);
  });

  it("rejects a missing target wallet address", async () => {
    vi.mocked(target.getWalletAccounts).mockResolvedValue([]);
    expect((await validateMigratedData(store, source, target)).failed).toBe(1);
  });

  it("rejects the same wallet address returned at the wrong derivation path", async () => {
    vi.mocked(target.getWalletAccounts).mockResolvedValue([
      { ...account, path: "m/44'/501'/1'/0'" },
    ]);
    expect((await verifyMigration(store, target))[0].passed).toBe(false);
  });

  it("rejects an unavailable live source instead of using old snapshot metadata", async () => {
    vi.mocked(source.listWallets).mockResolvedValue([]);
    expect((await validateMigratedData(store, source, target)).failed).toBe(1);
  });

  it("does not omit imported items lacking target IDs", async () => {
    store.getManifest().items[0].targetId = undefined;
    const results = await verifyMigration(store, target);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
  });

  it("rechecks resources that were previously verified", async () => {
    store.getManifest().items[0].status = "verified";
    vi.mocked(target.listWallets).mockResolvedValue([]);
    const results = await verifyMigration(store, target);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(store.getManifest().items[0].status).toBe("imported");
  });

  it("reports pending items as failures rather than a successful empty report", async () => {
    store.getManifest().items[0].status = "discovered";
    expect((await validateMigratedData(store, source, target)).failed).toBe(1);
  });
});
