import { describe, it, expect, vi, afterEach } from "vitest";
import { createZeroXKeyTargetClient } from "../core/target-0xkey.js";
import { createTurnkeySourceClient } from "../core/source-turnkey.js";
import { generateP256KeyPair } from "@turnkey/crypto";

const key = generateP256KeyPair();
const targetConfig = {
  provider: "0xkey" as const,
  apiBaseUrl: "https://api.0xkey.example",
  organizationId: "target",
  userId: "user",
  apiPrivateKey: key.privateKey,
  apiPublicKey: key.publicKey,
  signerPublicKey: key.publicKeyUncompressed,
};
const sourceConfig = {
  provider: "turnkey" as const,
  apiBaseUrl: "https://api.turnkey.com",
  organizationId: "source",
  apiPrivateKey: key.privateKey,
  apiPublicKey: key.publicKey,
};
function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("published SDK adapter contracts", () => {
  it("returns an import activity immediately without hiding pending approval", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response({
        activity: {
          id: "act-1",
          organizationId: "target",
          type: "ACTIVITY_TYPE_IMPORT_WALLET",
          status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
          result: {},
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = await createZeroXKeyTargetClient(targetConfig);
    const result = await client.importWallet({
      walletName: "Wallet",
      encryptedBundle: "encrypted",
      accounts: [],
    });
    expect(result.activityId).toBe("act-1");
    expect(result.walletId).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, request] = fetcher.mock.calls[0];
    expect(request.redirect).toBe("error");
    expect(request.body).not.toContain(key.privateKey);
    expect(JSON.parse(request.body).type).toBe("ACTIVITY_TYPE_IMPORT_WALLET");
  });

  it("fetches wallet accounts through every cursor including short pages", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = await createTurnkeySourceClient(sourceConfig);
    // Wallet list and account queries are distinct; the pinned API does not paginate wallet lists.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url, init) => {
        if (url.endsWith("wallets"))
          return response({
            wallets: [
              {
                walletId: "w1",
                walletName: "Wallet",
                imported: false,
                exported: false,
              },
            ],
          });
        const body = JSON.parse(init.body);
        requests.push(body);
        return response({
          accounts:
            requests.length === 1
              ? [
                  {
                    walletAccountId: "a1",
                    organizationId: "source",
                    walletId: "w1",
                    curve: "CURVE_SECP256K1",
                    pathFormat: "PATH_FORMAT_BIP32",
                    path: "m/0",
                    addressFormat: "ADDRESS_FORMAT_ETHEREUM",
                    address: "0xabc",
                  },
                ]
              : [],
        });
      }),
    );
    expect((await client.listWallets())[0].accounts).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].paginationOptions).toEqual({
      limit: "100",
      after: "a1",
    });
  });

  it("rejects repeated account cursors instead of accepting a partial inventory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url) =>
        response(
          url.endsWith("wallets")
            ? { wallets: [{ walletId: "w1", walletName: "Wallet" }] }
            : {
                accounts: [
                  {
                    walletAccountId: "a1",
                    organizationId: "source",
                    walletId: "w1",
                    curve: "CURVE_SECP256K1",
                    pathFormat: "PATH_FORMAT_BIP32",
                    path: "m/0",
                    addressFormat: "ADDRESS_FORMAT_ETHEREUM",
                    address: "0xabc",
                  },
                ],
              },
        ),
      ),
    );
    const client = await createTurnkeySourceClient(sourceConfig);
    await expect(client.listWallets()).rejects.toThrow(/pagination|cursor/i);
  });

  it("rejects import activities from a different organization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          activity: {
            id: "act-1",
            organizationId: "wrong-org",
            type: "ACTIVITY_TYPE_IMPORT_WALLET",
            status: "ACTIVITY_STATUS_COMPLETED",
            result: {
              importWalletResult: { walletId: "tw1", addresses: [] },
            },
          },
        }),
      ),
    );
    const client = await createZeroXKeyTargetClient(targetConfig);
    await expect(
      client.importWallet({
        walletName: "Wallet",
        encryptedBundle: "encrypted",
        accounts: [],
      }),
    ).rejects.toThrow(/context|organization/i);
  });
});
