import { describe, it, expect } from "vitest";
import { checkDuplicate } from "../core/dedup.js";
import type { MigrationItem } from "../types/resources.js";
import type {
  ZeroXKeyTargetClient,
  TargetPrivateKey,
} from "../core/target-0xkey.js";
const address = { format: "ADDRESS_FORMAT_ETHEREUM", address: "0xabc" };
const exact: TargetPrivateKey = {
  privateKeyId: "exact",
  publicKey: "abcd",
  curve: "CURVE_SECP256K1",
  addresses: [address],
};
const item: MigrationItem = {
  id: "key",
  sourceId: "key",
  sourceName: "Key",
  resourceType: "private_key",
  idempotencyKey: "key",
  status: "discovered",
  retryCount: 0,
  sourceMetadata: {
    type: "private_key",
    publicKey: "abcd",
    curve: "CURVE_SECP256K1",
    addresses: [address],
  },
};
describe("complete duplicate inventory", () => {
  it.each(["key", "wallet"])(
    "refuses an exact key plus conflicting %s",
    async (kind) => {
      const target = {
        listPrivateKeys: async () =>
          kind === "key"
            ? [exact, { ...exact, privateKeyId: "overlap", publicKey: "ffff" }]
            : [exact],
        listWallets: async () =>
          kind === "wallet"
            ? [{ walletId: "wallet", walletName: "Wallet" }]
            : [],
        getWalletAccounts: async () => [
          {
            address: address.address,
            addressFormat: address.format,
            curve: exact.curve,
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/0",
          },
        ],
      } as unknown as ZeroXKeyTargetClient;
      expect(await checkDuplicate(item, target)).toMatchObject({
        isDuplicate: false,
        conflict: true,
      });
    },
  );
  it.each(["public key", "address"])(
    "blocks a partial %s identity match",
    async (field) => {
      const partial =
        field === "public key"
          ? { ...exact, addresses: [{ ...address, address: "0xdef" }] }
          : { ...exact, publicKey: "ffff" };
      const target = {
        listPrivateKeys: async () => [partial],
        listWallets: async () => [],
      } as unknown as ZeroXKeyTargetClient;
      expect(await checkDuplicate(item, target)).toMatchObject({
        isDuplicate: false,
        conflict: true,
      });
    },
  );
  it("allows a new identity without overlaps", async () => {
    const target = {
      listPrivateKeys: async () => [],
      listWallets: async () => [],
    } as unknown as ZeroXKeyTargetClient;
    expect(await checkDuplicate(item, target)).toMatchObject({
      isDuplicate: false,
      conflict: false,
    });
  });
  it("accepts one exact key without other overlaps", async () => {
    const target = {
      listPrivateKeys: async () => [exact],
      listWallets: async () => [],
    } as unknown as ZeroXKeyTargetClient;
    expect(await checkDuplicate(item, target)).toMatchObject({
      isDuplicate: true,
      targetId: "exact",
    });
  });
});
