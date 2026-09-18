import { describe, it, expect, vi } from "vitest";
import { bridgeWallet, bridgePrivateKey } from "../core/crypto-bridge.js";
import { SecureBuffer } from "../core/secure-memory.js";

vi.mock("@turnkey/crypto", () => ({
  decryptExportBundle: async (params: {
    dangerouslyOverrideSignerPublicKey?: string;
  }) => {
    if (params.dangerouslyOverrideSignerPublicKey)
      throw new Error("untrusted signer override reached decrypt");
    return "synthetic secret";
  },
}));
vi.mock("@0xkey-io/crypto", () => ({
  encryptWalletToBundle: async (params: {
    dangerouslyOverrideSignerPublicKey?: string;
  }) => {
    if (
      params.dangerouslyOverrideSignerPublicKey !==
      "independently-trusted-signer"
    )
      throw new Error("untrusted target signer");
    return "encrypted";
  },
  encryptPrivateKeyToBundle: async (params: {
    dangerouslyOverrideSignerPublicKey?: string;
  }) => {
    if (
      params.dangerouslyOverrideSignerPublicKey !==
      "independently-trusted-signer"
    )
      throw new Error("untrusted target signer");
    return "encrypted";
  },
}));

describe("crypto bridge trust boundary", () => {
  it.each(["wallet", "private_key"])(
    "does not trust signer keys supplied by a %s bundle",
    async (kind) => {
      const ephemeralPrivateKey = SecureBuffer.fromString("ephemeral");
      const params = {
        turnkeyExportBundle: JSON.stringify({
          enclaveQuorumPublic: "attacker-key",
        }),
        ephemeralPrivateKey,
        turnkeyOrganizationId: "source",
        zeroxkeyImportBundle: JSON.stringify({
          enclaveQuorumPublic: "attacker-key",
        }),
        zeroxkeyUserId: "user",
        zeroxkeyOrganizationId: "target",
        zeroxkeySignerPublicKey: "independently-trusted-signer",
        keyFormat: "HEXADECIMAL" as const,
      };
      const result =
        kind === "wallet"
          ? await bridgeWallet(params)
          : await bridgePrivateKey(params);
      expect(result.encryptedBundle).toBe("encrypted");
      expect(ephemeralPrivateKey.isZeroed).toBe(true);
    },
  );
});
