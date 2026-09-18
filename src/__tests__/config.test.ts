import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig, ConfigValidationError } from "../core/config.js";

describe("loadConfig", () => {
  let configPath: string;

  beforeEach(() => {
    configPath = join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      `test-config-${randomUUID()}.yaml`,
    );
  });

  afterEach(async () => {
    await unlink(configPath).catch(() => {});
  });

  const validYaml = `
source:
  provider: turnkey
  apiBaseUrl: https://api.turnkey.com
  organizationId: org-s
  apiPublicKey: pub
  apiPrivateKey: priv
target:
  provider: "0xkey"
  apiBaseUrl: https://api.0xkey.io
  organizationId: org-t
  userId: user-t
  signerPublicKey: "04${"11".repeat(64)}"
  apiPublicKey: pub-t
  apiPrivateKey: priv-t
resources:
  wallets: all
  privateKeys: all
state:
  manifestPath: ./manifest.json
`;

  it("should load valid config", async () => {
    await writeFile(configPath, validYaml);
    const config = await loadConfig(configPath);
    expect(config.source.provider).toBe("turnkey");
    expect(config.target.provider).toBe("0xkey");
    expect(config.resources.wallets).toBe("all");
    expect(config.state.manifestPath).toBe("./manifest.json");
  });

  it("should resolve environment variables", async () => {
    process.env.TEST_ORG_ID = "resolved-org";
    const yaml = validYaml.replace("org-s", "$TEST_ORG_ID");
    await writeFile(configPath, yaml);
    const config = await loadConfig(configPath);
    expect(config.source.organizationId).toBe("resolved-org");
    delete process.env.TEST_ORG_ID;
  });

  it("should throw on missing env var", async () => {
    const yaml = validYaml.replace("org-s", "$MISSING_VAR_XYZ");
    await writeFile(configPath, yaml);
    await expect(loadConfig(configPath)).rejects.toThrow("MISSING_VAR_XYZ");
  });

  it("should throw ConfigValidationError on missing source", async () => {
    await writeFile(
      configPath,
      `
target:
  provider: "0xkey"
  apiBaseUrl: https://api.0xkey.io
  organizationId: org-t
  userId: user-t
  apiPublicKey: pub-t
  apiPrivateKey: priv-t
resources:
  wallets: all
state:
  manifestPath: ./m.json
`,
    );
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
  });

  it("should throw on invalid resources format", async () => {
    const yaml = validYaml.replace("wallets: all", "wallets: 123");
    await writeFile(configPath, yaml);
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
  });

  it("should throw on empty file", async () => {
    await writeFile(configPath, "");
    await expect(loadConfig(configPath)).rejects.toThrow("empty");
  });

  it("preserves quotes and backslashes in environment values", async () => {
    process.env.TEST_ORG_ID = 'org"with\\characters';
    try {
      await writeFile(configPath, validYaml.replace("org-s", "$TEST_ORG_ID"));
      expect((await loadConfig(configPath)).source.organizationId).toBe(
        'org"with\\characters',
      );
    } finally {
      delete process.env.TEST_ORG_ID;
    }
  });

  it.each([
    "http://api.turnkey.com",
    "https://user:password@api.turnkey.com",
    "https://api.turnkey.com/?token=secret",
  ])(
    "rejects unsafe API base URLs without printing their contents: %s",
    async (url) => {
      await writeFile(
        configPath,
        validYaml.replace("https://api.turnkey.com", url),
      );
      await expect(loadConfig(configPath)).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(loadConfig(configPath)).rejects.not.toThrow("password");
    },
  );

  it("rejects malformed resource IDs", async () => {
    await writeFile(
      configPath,
      validYaml.replace("wallets: all", "wallets: [42, '']"),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
  });

  it("requires a target signer key obtained independently of the bundle", async () => {
    await writeFile(
      configPath,
      validYaml.replace(/  signerPublicKey:.*\n/, ""),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      "target.signerPublicKey",
    );
  });
});
