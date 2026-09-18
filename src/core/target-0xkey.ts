import { ZeroXKeyClient } from "@0xkey-io/http";
import { ApiKeyStamper, type ZeroXKeyApiTypes } from "@0xkey-io/sdk-server";
import type {
  TargetConfig,
  WalletAccountSpec,
  ResourceType,
} from "../types/index.js";
import {
  allAccounts,
  bindTransport,
  type ApiOptions,
} from "./api-transport.js";
import { pollActivity } from "./activity-poller.js";
import { ToolError } from "./errors.js";

export interface InitImportResult {
  importBundle: string;
  activityId: string;
}
export interface ImportWalletResult {
  walletId?: string;
  addresses: string[];
  activityId: string;
}
export interface ImportPrivateKeyResult {
  privateKeyId?: string;
  addresses: Array<{ format: string; address: string }>;
  activityId: string;
}
export interface TargetWallet {
  walletId: string;
  walletName: string;
  exported: boolean;
  imported: boolean;
}
export interface TargetWalletAccount {
  curve: string;
  pathFormat: string;
  path: string;
  addressFormat: string;
  address: string;
}
export interface TargetPrivateKey {
  privateKeyId: string;
  publicKey: string;
  curve: string;
  addresses: Array<{ format: string; address: string }>;
}
export interface ZeroXKeyTargetClient {
  initImportWallet(): Promise<InitImportResult>;
  importWallet(params: {
    walletName: string;
    encryptedBundle: string;
    accounts: WalletAccountSpec[];
  }): Promise<ImportWalletResult>;
  initImportPrivateKey(): Promise<InitImportResult>;
  importPrivateKey(params: {
    privateKeyName: string;
    encryptedBundle: string;
    curve: string;
    addressFormats: string[];
  }): Promise<ImportPrivateKeyResult>;
  listWallets(): Promise<TargetWallet[]>;
  listPrivateKeys(): Promise<TargetPrivateKey[]>;
  getWalletAccounts(walletId: string): Promise<TargetWalletAccount[]>;
  getActivity(
    activityId: string,
    expectedType?: string,
  ): Promise<{ status: string; result?: unknown }>;
}

export function importIdentity(
  result: unknown,
  kind: ResourceType,
): { targetId: string; targetAddresses: string[] } {
  const response = result as ZeroXKeyApiTypes["v1Result"] | undefined;
  const value =
    kind === "wallet"
      ? response?.importWalletResult
      : response?.importPrivateKeyResult;
  const targetId =
    value && ("walletId" in value ? value.walletId : value.privateKeyId);
  if (!targetId || !value || !Array.isArray(value.addresses))
    throw new ToolError(
      "E_IMPORT_IDENTITY",
      "Completed import has no verifiable target identity. Preserve state for manual reconciliation.",
    );
  const addresses = value.addresses.map((a) =>
    typeof a === "string" ? a : a.address,
  );
  if (addresses.some((a) => typeof a !== "string" || !a))
    throw new ToolError(
      "E_IMPORT_IDENTITY",
      "Import returned malformed target addresses.",
    );
  return { targetId, targetAddresses: addresses as string[] };
}

export async function createZeroXKeyTargetClient(
  config: TargetConfig,
  options: ApiOptions = {},
): Promise<ZeroXKeyTargetClient> {
  const client = bindTransport(
    new ZeroXKeyClient(
      { baseUrl: config.apiBaseUrl },
      new ApiKeyStamper(config),
    ),
    options,
  );
  const org = config.organizationId;
  const activityContext = (
    activity: ZeroXKeyApiTypes["v1Activity"],
    expectedType?: string,
    id?: string,
  ): void => {
    if (
      !activity?.id ||
      activity.organizationId !== org ||
      (id && activity.id !== id) ||
      (expectedType && activity.type !== expectedType)
    ) {
      throw new ToolError(
        "E_ACTIVITY_CONTEXT",
        "Target activity organization/type/ID context does not match.",
      );
    }
  };
  const readActivity = async (id: string, expectedType?: string) => {
    const response = await client.getActivity({
      organizationId: org,
      activityId: id,
    });
    activityContext(response.activity, expectedType, id);
    return {
      status: response.activity.status,
      result: response.activity.result,
    };
  };
  const completeInit = async (
    activity: ZeroXKeyApiTypes["v1Activity"],
    type: string,
    field: "initImportWalletResult" | "initImportPrivateKeyResult",
  ): Promise<InitImportResult> => {
    activityContext(activity, type);
    const completed = await pollActivity(
      { getActivity: (id) => readActivity(id, type) },
      activity.id,
      { initialActivity: activity },
    );
    const bundle = (
      completed.result as ZeroXKeyApiTypes["v1Result"] | undefined
    )?.[field]?.importBundle;
    if (!bundle)
      throw new ToolError(
        "E_API_RESPONSE",
        "Completed import initialization returned no bundle.",
      );
    return { importBundle: bundle, activityId: activity.id };
  };
  return {
    async initImportWallet() {
      const response = await client.initImportWallet({
        type: "ACTIVITY_TYPE_INIT_IMPORT_WALLET",
        organizationId: org,
        timestampMs: String(Date.now()),
        parameters: { userId: config.userId },
      });
      return completeInit(
        response.activity,
        "ACTIVITY_TYPE_INIT_IMPORT_WALLET",
        "initImportWalletResult",
      );
    },
    async initImportPrivateKey() {
      const response = await client.initImportPrivateKey({
        type: "ACTIVITY_TYPE_INIT_IMPORT_PRIVATE_KEY",
        organizationId: org,
        timestampMs: String(Date.now()),
        parameters: { userId: config.userId },
      });
      return completeInit(
        response.activity,
        "ACTIVITY_TYPE_INIT_IMPORT_PRIVATE_KEY",
        "initImportPrivateKeyResult",
      );
    },
    async importWallet(params) {
      const response = await client.importWallet({
        type: "ACTIVITY_TYPE_IMPORT_WALLET",
        organizationId: org,
        timestampMs: String(Date.now()),
        parameters: {
          userId: config.userId,
          walletName: params.walletName,
          encryptedBundle: params.encryptedBundle,
          accounts: params.accounts.map((a) => ({
            curve: a.curve as ZeroXKeyApiTypes["v1Curve"],
            pathFormat: a.pathFormat as ZeroXKeyApiTypes["v1PathFormat"],
            path: a.path,
            addressFormat:
              a.addressFormat as ZeroXKeyApiTypes["v1AddressFormat"],
          })),
        },
      });
      activityContext(response.activity, "ACTIVITY_TYPE_IMPORT_WALLET");
      return {
        activityId: response.activity.id,
        walletId: response.activity.result?.importWalletResult?.walletId,
        addresses:
          response.activity.result?.importWalletResult?.addresses ?? [],
      };
    },
    async importPrivateKey(params) {
      const response = await client.importPrivateKey({
        type: "ACTIVITY_TYPE_IMPORT_PRIVATE_KEY",
        organizationId: org,
        timestampMs: String(Date.now()),
        parameters: {
          userId: config.userId,
          privateKeyName: params.privateKeyName,
          encryptedBundle: params.encryptedBundle,
          curve: params.curve as ZeroXKeyApiTypes["v1Curve"],
          addressFormats:
            params.addressFormats as ZeroXKeyApiTypes["v1AddressFormat"][],
        },
      });
      activityContext(response.activity, "ACTIVITY_TYPE_IMPORT_PRIVATE_KEY");
      return {
        activityId: response.activity.id,
        privateKeyId:
          response.activity.result?.importPrivateKeyResult?.privateKeyId,
        addresses: (
          response.activity.result?.importPrivateKeyResult?.addresses ?? []
        ).map((a) => ({ format: a.format ?? "", address: a.address ?? "" })),
      };
    },
    async listWallets() {
      const response = await client.getWallets({ organizationId: org });
      if (!Array.isArray(response.wallets))
        throw new ToolError(
          "E_API_RESPONSE",
          "Target wallet inventory is malformed.",
        );
      return response.wallets.map((w) => ({
        walletId: w.walletId,
        walletName: w.walletName,
        imported: w.imported,
        exported: w.exported,
      }));
    },
    async listPrivateKeys() {
      const response = await client.getPrivateKeys({ organizationId: org });
      if (!Array.isArray(response.privateKeys))
        throw new ToolError(
          "E_API_RESPONSE",
          "Target key inventory is malformed.",
        );
      return response.privateKeys.map((k) => ({
        privateKeyId: k.privateKeyId,
        publicKey: k.publicKey,
        curve: k.curve,
        addresses: k.addresses.map((a) => ({
          format: a.format ?? "",
          address: a.address ?? "",
        })),
      }));
    },
    async getWalletAccounts(walletId) {
      const accounts = await allAccounts(
        async (after) =>
          (
            await client.getWalletAccounts({
              organizationId: org,
              walletId,
              paginationOptions: { limit: "100", ...(after ? { after } : {}) },
            })
          ).accounts,
        org,
        walletId,
      );
      return accounts.map((a) => ({
        curve: a.curve,
        pathFormat: a.pathFormat,
        path: a.path,
        addressFormat: a.addressFormat,
        address: a.address,
      }));
    },
    getActivity: readActivity,
  };
}
