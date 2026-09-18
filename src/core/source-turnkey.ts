import { TurnkeyClient } from "@turnkey/http";
import { ApiKeyStamper } from "@turnkey/sdk-server";
import type {
  SourceConfig,
  SourceWallet,
  SourcePrivateKey,
} from "../types/index.js";
import {
  allAccounts,
  bindTransport,
  type ApiOptions,
} from "./api-transport.js";
import { pollActivity } from "./activity-poller.js";
import { ToolError } from "./errors.js";

export interface TurnkeyExportResult {
  exportBundle: string;
}
export interface TurnkeySourceClient {
  listWallets(): Promise<SourceWallet[]>;
  listPrivateKeys(): Promise<SourcePrivateKey[]>;
  exportWallet(
    walletId: string,
    targetPublicKey: string,
  ): Promise<TurnkeyExportResult>;
  exportPrivateKey(
    privateKeyId: string,
    targetPublicKey: string,
  ): Promise<TurnkeyExportResult>;
  exportWalletAccount(
    address: string,
    targetPublicKey: string,
  ): Promise<TurnkeyExportResult>;
}

export async function createTurnkeySourceClient(
  config: SourceConfig,
  options: ApiOptions = {},
): Promise<TurnkeySourceClient> {
  const client = bindTransport(
    new TurnkeyClient(
      { baseUrl: config.apiBaseUrl },
      new ApiKeyStamper(config),
    ),
    options,
  );
  const org = config.organizationId;
  const context = (
    activity: { id: string; organizationId: string; type: string },
    expected: string,
  ): void => {
    if (
      !activity?.id ||
      activity.organizationId !== org ||
      activity.type !== expected
    )
      throw new ToolError(
        "E_ACTIVITY_CONTEXT",
        "Source activity organization/type context does not match.",
      );
  };
  const finishExport = async (
    activity: {
      id: string;
      organizationId: string;
      type: string;
      status: string;
      result: unknown;
    },
    type: string,
    field: string,
  ): Promise<TurnkeyExportResult> => {
    context(activity, type);
    const completed = await pollActivity(
      {
        getActivity: async (id: string) => {
          const response = await client.getActivity({
            organizationId: org,
            activityId: id,
          });
          context(response.activity, type);
          if (response.activity.id !== id)
            throw new ToolError(
              "E_ACTIVITY_CONTEXT",
              "Source activity ID does not match.",
            );
          return response.activity;
        },
      },
      activity.id,
      { initialActivity: activity },
    );
    const result = (
      completed.result as Record<string, { exportBundle?: string }> | undefined
    )?.[field];
    if (!result?.exportBundle)
      throw new ToolError(
        "E_API_RESPONSE",
        "Completed source export did not contain a bundle.",
      );
    return { exportBundle: result.exportBundle };
  };
  return {
    async listWallets() {
      const result = await client.getWallets({ organizationId: org });
      if (!Array.isArray(result.wallets))
        throw new ToolError(
          "E_API_RESPONSE",
          "Source wallet inventory is malformed.",
        );
      const wallets: SourceWallet[] = [];
      for (const w of result.wallets) {
        const accounts = await allAccounts(
          async (after) =>
            (
              await client.getWalletAccounts({
                organizationId: org,
                walletId: w.walletId,
                paginationOptions: {
                  limit: "100",
                  ...(after ? { after } : {}),
                },
              })
            ).accounts,
          org,
          w.walletId,
        );
        wallets.push({
          walletId: w.walletId,
          walletName: w.walletName,
          accounts: accounts.map((a) => ({
            curve: a.curve,
            pathFormat: a.pathFormat,
            path: a.path,
            addressFormat: a.addressFormat,
            address: a.address,
          })),
          exported: w.exported,
          imported: w.imported,
        });
      }
      return wallets;
    },
    async listPrivateKeys() {
      const result = await client.getPrivateKeys({ organizationId: org });
      if (!Array.isArray(result.privateKeys))
        throw new ToolError(
          "E_API_RESPONSE",
          "Source key inventory is malformed.",
        );
      return result.privateKeys.map((pk) => ({
        privateKeyId: pk.privateKeyId,
        privateKeyName: pk.privateKeyName,
        publicKey: pk.publicKey,
        curve: pk.curve,
        addresses: pk.addresses.map((a) => ({
          format: a.format ?? "",
          address: a.address ?? "",
        })),
        exported: pk.exported,
        imported: pk.imported,
      }));
    },
    async exportWallet(walletId, targetPublicKey) {
      const response = await client.exportWallet({
        type: "ACTIVITY_TYPE_EXPORT_WALLET",
        organizationId: org,
        timestampMs: String(Date.now()),
        parameters: { walletId, targetPublicKey },
      });
      return finishExport(
        response.activity,
        "ACTIVITY_TYPE_EXPORT_WALLET",
        "exportWalletResult",
      );
    },
    async exportPrivateKey(privateKeyId, targetPublicKey) {
      const response = await client.exportPrivateKey({
        type: "ACTIVITY_TYPE_EXPORT_PRIVATE_KEY",
        organizationId: org,
        timestampMs: String(Date.now()),
        parameters: { privateKeyId, targetPublicKey },
      });
      return finishExport(
        response.activity,
        "ACTIVITY_TYPE_EXPORT_PRIVATE_KEY",
        "exportPrivateKeyResult",
      );
    },
    async exportWalletAccount(address, targetPublicKey) {
      const response = await client.exportWalletAccount({
        type: "ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT",
        organizationId: org,
        timestampMs: String(Date.now()),
        parameters: { address, targetPublicKey },
      });
      return finishExport(
        response.activity,
        "ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT",
        "exportWalletAccountResult",
      );
    },
  };
}
