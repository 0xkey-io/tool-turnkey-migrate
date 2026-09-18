import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { decryptExportBundle } from "@turnkey/crypto";
import { encryptPrivateKeyToBundle } from "@0xkey-io/crypto";
import { bridgeWallet } from "../core/crypto-bridge.js";
import { SecureBuffer } from "../core/secure-memory.js";
function signedBundle(data: object) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const signer =
    "04" +
    Buffer.from(jwk.x!, "base64url").toString("hex") +
    Buffer.from(jwk.y!, "base64url").toString("hex");
  const bytes = Buffer.from(JSON.stringify(data));
  return {
    signer,
    bundle: JSON.stringify({
      enclaveQuorumPublic: signer,
      data: bytes.toString("hex"),
      dataSignature: sign("sha256", bytes, privateKey).toString("hex"),
    }),
  };
}
describe("pinned SDK signature and context validation", () => {
  it("rejects a correctly self-signed source bundle against the trusted Turnkey anchor", async () => {
    const fixture = signedBundle({ organizationId: "source" });
    await expect(
      decryptExportBundle({
        exportBundle: fixture.bundle,
        embeddedKey: "01".repeat(32),
        returnMnemonic: false,
        organizationId: "source",
      }),
    ).rejects.toThrow(/signer/i);
    const key = SecureBuffer.fromString("01".repeat(32));
    await expect(
      bridgeWallet({
        turnkeyExportBundle: fixture.bundle,
        ephemeralPrivateKey: key,
        turnkeyOrganizationId: "source",
        zeroxkeyImportBundle: fixture.bundle,
        zeroxkeyUserId: "user",
        zeroxkeyOrganizationId: "target",
        zeroxkeySignerPublicKey: fixture.signer,
      }),
    ).rejects.toThrow(/signer/i);
    expect(key.isZeroed).toBe(true);
  });
  it.each(["organization", "user"])(
    "rejects a signed target bundle with the wrong %s",
    async (field) => {
      const fixture = signedBundle({
        organizationId: field === "organization" ? "wrong" : "target",
        userId: field === "user" ? "wrong" : "user",
      });
      await expect(
        encryptPrivateKeyToBundle({
          privateKey: "01".repeat(32),
          keyFormat: "HEXADECIMAL",
          importBundle: fixture.bundle,
          userId: "user",
          organizationId: "target",
          dangerouslyOverrideSignerPublicKey: fixture.signer,
        }),
      ).rejects.toThrow(new RegExp(`${field} id does not match`, "i"));
    },
  );
  it("rejects a forged signature even when the target signer is pinned", async () => {
    const fixture = signedBundle({ organizationId: "target", userId: "user" });
    const forged = JSON.parse(fixture.bundle);
    forged.data = Buffer.from(
      JSON.stringify({ organizationId: "target", userId: "attacker" }),
    ).toString("hex");
    await expect(
      encryptPrivateKeyToBundle({
        privateKey: "01".repeat(32),
        keyFormat: "HEXADECIMAL",
        importBundle: JSON.stringify(forged),
        userId: "user",
        organizationId: "target",
        dangerouslyOverrideSignerPublicKey: fixture.signer,
      }),
    ).rejects.toThrow(/signature/i);
  });
});
