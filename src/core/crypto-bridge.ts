/**
 * Crypto bridge — local decrypt/re-encrypt between Turnkey and 0xkey.
 *
 * Key insight: use @turnkey/crypto to DECRYPT (Turnkey enclave signature),
 *              use @0xkey-io/crypto to ENCRYPT (0xkey enclave target).
 *
 * Trust anchors are independent of bundle content. Turnkey uses its SDK default;
 * 0xkey uses the operator-verified signer key from configuration.
 *
 * Security invariants:
 * - Plaintext (mnemonic / private key) is wrapped in SecureBuffer
 * - Zeroed immediately after re-encryption completes or on error
 * - Never logged, never written to disk
 */

import { SecureBuffer } from "./secure-memory.js";

export interface EphemeralKeyPair {
  privateKey: SecureBuffer;
  publicKeyUncompressed: string;
}

export interface BridgeWalletResult {
  encryptedBundle: string;
}

export interface BridgePrivateKeyResult {
  encryptedBundle: string;
}

export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const { generateP256KeyPair } = await import("@turnkey/crypto");
  const kp = generateP256KeyPair();
  return {
    privateKey: SecureBuffer.fromString(kp.privateKey),
    publicKeyUncompressed: kp.publicKeyUncompressed,
  };
}

export async function bridgeWallet(params: {
  turnkeyExportBundle: string;
  ephemeralPrivateKey: SecureBuffer;
  turnkeyOrganizationId: string;
  zeroxkeyImportBundle: string;
  zeroxkeyUserId: string;
  zeroxkeyOrganizationId: string;
  zeroxkeySignerPublicKey: string;
}): Promise<BridgeWalletResult> {
  let mnemonicBuf: SecureBuffer | undefined;
  try {
    const turnkeyCrypto = await import("@turnkey/crypto");
    const oxkeyCrypto = await import("@0xkey-io/crypto");
    const mnemonic = await turnkeyCrypto.decryptExportBundle({
      exportBundle: params.turnkeyExportBundle,
      embeddedKey: params.ephemeralPrivateKey.toString(),
      organizationId: params.turnkeyOrganizationId,
      returnMnemonic: true,
    });
    mnemonicBuf = SecureBuffer.fromString(mnemonic);

    const encryptedBundle = await oxkeyCrypto.encryptWalletToBundle({
      mnemonic: mnemonicBuf.toString(),
      importBundle: params.zeroxkeyImportBundle,
      userId: params.zeroxkeyUserId,
      organizationId: params.zeroxkeyOrganizationId,
      dangerouslyOverrideSignerPublicKey: params.zeroxkeySignerPublicKey,
    });
    return { encryptedBundle };
  } finally {
    mnemonicBuf?.zero();
    params.ephemeralPrivateKey.zero();
  }
}

export async function bridgePrivateKey(params: {
  turnkeyExportBundle: string;
  ephemeralPrivateKey: SecureBuffer;
  turnkeyOrganizationId: string;
  zeroxkeyImportBundle: string;
  zeroxkeyUserId: string;
  zeroxkeyOrganizationId: string;
  keyFormat: "HEXADECIMAL" | "SOLANA";
  zeroxkeySignerPublicKey: string;
}): Promise<BridgePrivateKeyResult> {
  let keyBuf: SecureBuffer | undefined;
  try {
    const turnkeyCrypto = await import("@turnkey/crypto");
    const oxkeyCrypto = await import("@0xkey-io/crypto");
    const privateKeyValue = await turnkeyCrypto.decryptExportBundle({
      exportBundle: params.turnkeyExportBundle,
      embeddedKey: params.ephemeralPrivateKey.toString(),
      organizationId: params.turnkeyOrganizationId,
      returnMnemonic: false,
      keyFormat: params.keyFormat,
    });
    keyBuf = SecureBuffer.fromString(privateKeyValue);

    const encryptedBundle = await oxkeyCrypto.encryptPrivateKeyToBundle({
      privateKey: keyBuf.toString(),
      keyFormat: params.keyFormat,
      importBundle: params.zeroxkeyImportBundle,
      userId: params.zeroxkeyUserId,
      organizationId: params.zeroxkeyOrganizationId,
      dangerouslyOverrideSignerPublicKey: params.zeroxkeySignerPublicKey,
    });
    return { encryptedBundle };
  } finally {
    keyBuf?.zero();
    params.ephemeralPrivateKey.zero();
  }
}
