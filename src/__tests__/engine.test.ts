import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MigrationEngine } from "../core/engine.js";
import {
  createTurnkeySourceClient,
  type TurnkeySourceClient,
} from "../core/source-turnkey.js";
import {
  createZeroXKeyTargetClient,
  type ZeroXKeyTargetClient,
} from "../core/target-0xkey.js";
import {
  generateEphemeralKeyPair,
  bridgeWallet,
  bridgePrivateKey,
} from "../core/crypto-bridge.js";
import { SecureBuffer } from "../core/secure-memory.js";
import { createLogger } from "../core/logger.js";
import type { MigrationConfig } from "../types/config.js";
import { writeFile, readFile, rm, mkdtemp, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../core/source-turnkey.js", () => ({
  createTurnkeySourceClient: vi.fn(),
}));
vi.mock("../core/target-0xkey.js", async (original) => ({
  ...(await original<typeof import("../core/target-0xkey.js")>()),
  createZeroXKeyTargetClient: vi.fn(),
}));
vi.mock("../core/crypto-bridge.js", () => ({
  generateEphemeralKeyPair: vi.fn(),
  bridgeWallet: vi.fn(),
  bridgePrivateKey: vi.fn().mockResolvedValue({ encryptedBundle: "encrypted" }),
}));

export function makeConfig(manifestPath: string): MigrationConfig {
  return {
    source: {
      provider: "turnkey",
      apiBaseUrl: "https://api.turnkey.com",
      organizationId: "source-org",
      apiPublicKey: "public",
      apiPrivateKey: "private",
    },
    target: {
      provider: "0xkey",
      apiBaseUrl: "https://api.0xkey.example",
      organizationId: "target-org",
      userId: "target-user",
      apiPublicKey: "public",
      apiPrivateKey: "private",
      signerPublicKey: `04${"11".repeat(64)}`,
    },
    resources: { wallets: "all", privateKeys: [] },
    state: { manifestPath },
  };
}

const account = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/44'/60'/0'/0/0",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM",
  address: "0xabc",
};

describe("MigrationEngine safety", () => {
  let directory: string;
  let path: string;
  let config: MigrationConfig;
  let source: TurnkeySourceClient;
  let target: ZeroXKeyTargetClient;
  let ephemeral: SecureBuffer;
  const log = createLogger({ level: "error" });

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(
      join(
        process.platform === "darwin" ? "/private/tmp" : tmpdir(),
        "migration-engine-",
      ),
    );
    path = join(directory, "manifest.json");
    config = makeConfig(path);
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
      exportWallet: vi
        .fn()
        .mockResolvedValue({ exportBundle: "export-bundle" }),
      exportPrivateKey: vi.fn(),
      exportWalletAccount: vi.fn(),
    };
    target = {
      listWallets: vi.fn().mockResolvedValue([]),
      listPrivateKeys: vi.fn().mockResolvedValue([]),
      getWalletAccounts: vi.fn().mockResolvedValue([account]),
      initImportWallet: vi.fn().mockResolvedValue({
        importBundle: "import-bundle",
        activityId: "init-1",
      }),
      importWallet: vi.fn().mockResolvedValue({
        walletId: "target-w1",
        addresses: ["0xabc"],
        activityId: "import-1",
      }),
      initImportPrivateKey: vi.fn(),
      importPrivateKey: vi.fn(),
      getActivity: vi.fn().mockResolvedValue({
        status: "ACTIVITY_STATUS_COMPLETED",
        result: {
          importWalletResult: { walletId: "target-w1", addresses: ["0xabc"] },
        },
      }),
    };
    vi.mocked(createTurnkeySourceClient).mockResolvedValue(source);
    vi.mocked(createZeroXKeyTargetClient).mockResolvedValue(target);
    ephemeral = SecureBuffer.fromString("ephemeral-private");
    vi.mocked(generateEphemeralKeyPair).mockResolvedValue({
      privateKey: ephemeral,
      publicKeyUncompressed: "ephemeral-public",
    });
    vi.mocked(bridgeWallet).mockResolvedValue({ encryptedBundle: "encrypted" });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects newly discovered resources during execution of a reviewed plan", async () => {
    const planner = new MigrationEngine({ config, logger: log });
    await planner.init();
    await planner.discover();
    await planner.finish();
    const before = await readFile(path, "utf8");
    const original = await source.listWallets();
    vi.mocked(source.listWallets).mockResolvedValue([
      ...original,
      { ...original[0], walletId: "w2" },
    ]);
    const execution = new MigrationEngine({ config, logger: log });
    await execution.init(true);
    await expect(execution.discover(false)).rejects.toThrow(/plan/i);
    await execution.finish();
    expect(source.exportWallet).not.toHaveBeenCalled();
    expect(target.importWallet).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path, "utf8")).items).toEqual(
      JSON.parse(before).items,
    );
  });

  it("completes a wallet transfer with durable target identity and key cleanup", async () => {
    const engine = new MigrationEngine({ config, logger: log });
    await engine.init();
    await engine.discover();
    const result = await engine.migrateAll();
    await engine.finish();
    expect(result.imported).toBe(1);
    expect(source.exportWallet).toHaveBeenCalledTimes(1);
    expect(target.importWallet).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(path, "utf8")).items[0]).toMatchObject({
      status: "imported",
      targetId: "target-w1",
      importActivityId: "import-1",
    });
    expect(ephemeral.isZeroed).toBe(true);
  });
  it.each(["CURVE_SECP256K1", "CURVE_ED25519"])(
    "completes a %s private key transfer with the correct encoding",
    async (curve) => {
      config.resources = { wallets: [], privateKeys: "all" };
      const format =
        curve === "CURVE_ED25519"
          ? "ADDRESS_FORMAT_SOLANA"
          : "ADDRESS_FORMAT_ETHEREUM";
      const address =
        curve === "CURVE_ED25519" ? "SyntheticCaseSensitiveAddress" : "0xabc";
      vi.mocked(source.listPrivateKeys).mockResolvedValue([
        {
          privateKeyId: "pk1",
          privateKeyName: "Key",
          publicKey: "ab".repeat(32),
          curve,
          addresses: [{ format, address }],
          exported: false,
          imported: false,
        },
      ]);
      vi.mocked(source.exportPrivateKey).mockResolvedValue({
        exportBundle: "export-bundle",
      });
      vi.mocked(target.initImportPrivateKey).mockResolvedValue({
        importBundle: "import-bundle",
        activityId: "init-key",
      });
      vi.mocked(target.importPrivateKey).mockResolvedValue({
        activityId: "import-key",
        privateKeyId: "target-key",
        addresses: [{ format, address }],
      });
      vi.mocked(target.getActivity).mockResolvedValue({
        status: "ACTIVITY_STATUS_COMPLETED",
        result: {
          importPrivateKeyResult: {
            privateKeyId: "target-key",
            addresses: [address],
          },
        },
      });
      const engine = new MigrationEngine({ config, logger: log });
      await engine.init();
      await engine.discover();
      const result = await engine.migrateAll();
      await engine.finish();
      expect(result.imported).toBe(1);
      expect(bridgePrivateKey).toHaveBeenCalledWith(
        expect.objectContaining({
          keyFormat: curve === "CURVE_ED25519" ? "SOLANA" : "HEXADECIMAL",
        }),
      );
      expect(target.importPrivateKey).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(path, "utf8")).items[0]).toMatchObject({
        status: "imported",
        targetId: "target-key",
        importActivityId: "import-key",
      });
      expect(ephemeral.isZeroed).toBe(true);
    },
  );
  it("keeps dry-run state byte-for-byte unchanged", async () => {
    const planner = new MigrationEngine({ config, logger: log });
    await planner.init();
    await planner.discover();
    await planner.finish();
    const before = await readFile(path, "utf8");
    const engine = new MigrationEngine({ config, dryRun: true, logger: log });
    await engine.init();
    await engine.discover();
    await engine.migrateAll();
    await engine.finish();
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("does not create a state file during a fresh dry-run", async () => {
    const engine = new MigrationEngine({ config, dryRun: true, logger: log });
    await engine.init();
    await engine.discover();
    await engine.migrateAll();
    await engine.finish();
    await expect(access(path)).rejects.toThrow();
  });

  it("releases the lock when initialization fails", async () => {
    await writeFile(path, "invalid JSON");
    const engine = new MigrationEngine({ config, logger: log });
    await expect(engine.init()).rejects.toThrow();
    await expect(access(`${path}.lock`)).rejects.toThrow();
  });

  it("clears the ephemeral key even when export fails before bridging", async () => {
    vi.mocked(source.exportWallet).mockRejectedValue(
      new Error("permission denied"),
    );
    const engine = new MigrationEngine({
      config,
      logger: log,
      retryMaxAttempts: 1,
    });
    await engine.init();
    await engine.discover();
    await engine.migrateAll();
    await engine.finish();
    expect(ephemeral.isZeroed).toBe(true);
  });

  it("persists the import activity before polling an uncertain result", async () => {
    vi.mocked(target.getActivity).mockImplementation(async () => {
      const state = JSON.parse(await readFile(path, "utf8"));
      expect(state.items[0].importActivityId).toBe("import-1");
      throw new Error("network timeout");
    });
    const engine = new MigrationEngine({
      config,
      logger: log,
      retryMaxAttempts: 1,
    });
    await engine.init();
    await engine.discover();
    await engine.migrateAll();
    await engine.finish();
    expect(
      JSON.parse(await readFile(path, "utf8")).items[0].importActivityId,
    ).toBe("import-1");
  });

  it("does not repeat an import after a lost response", async () => {
    vi.mocked(target.importWallet).mockRejectedValue(
      new Error("network timeout: SECRET_PAYLOAD"),
    );
    const engine = new MigrationEngine({
      config,
      logger: log,
      retryMaxAttempts: 3,
    });
    await engine.init();
    await engine.discover();
    const first = await engine.migrateAll();
    expect(first.failed).toBe(1);
    expect(target.importWallet).toHaveBeenCalledTimes(1);
    expect(engine.getManifest().items[0].status).toBe("needs_review");
    expect(await readFile(path, "utf8")).not.toContain("SECRET_PAYLOAD");
    await engine.resetFailed();
    await engine.migrateAll();
    await engine.finish();
    expect(target.importWallet).toHaveBeenCalledTimes(1);
  });

  it("reconciles an existing activity without exporting or importing again", async () => {
    const engine = new MigrationEngine({ config, logger: log });
    await engine.init();
    await engine.discover();
    const item = engine.getManifest().items[0];
    engine.getStore().updateStatus(item.idempotencyKey, "import_started", {
      importActivityId: "import-1",
    });
    await engine.getStore().save();
    const result = await engine.migrateAll();
    await engine.finish();
    expect(result.imported).toBe(1);
    expect(item.targetId).toBe("target-w1");
    expect(source.exportWallet).not.toHaveBeenCalled();
    expect(target.importWallet).not.toHaveBeenCalled();
  });

  it("fails closed when target duplicate checks are unavailable", async () => {
    vi.mocked(target.listPrivateKeys).mockRejectedValue(
      new Error("permission denied"),
    );
    const engine = new MigrationEngine({
      config,
      logger: log,
      retryMaxAttempts: 1,
    });
    await engine.init();
    await engine.discover();
    await expect(engine.migrateAll()).rejects.toThrow();
    await engine.finish();
    expect(source.exportWallet).not.toHaveBeenCalled();
  });

  it("does not migrate pending resources outside the current selection", async () => {
    const engine = new MigrationEngine({ config, logger: log });
    await engine.init();
    await engine.discover();
    await engine.finish();
    const next = new MigrationEngine({
      config: { ...config, resources: { wallets: [], privateKeys: [] } },
      logger: log,
    });
    await next.init();
    const result = await next.migrateAll();
    await next.finish();
    expect(result.imported).toBe(0);
    expect(source.exportWallet).not.toHaveBeenCalled();
  });
});
