/**
 * Resources that the migration tool handles.
 *
 * MVP scope:
 *   - wallets (HD wallets with mnemonic)
 *   - wallet accounts (derived accounts within a wallet)
 *   - standalone private keys
 *
 * Report-only (not auto-migrated in MVP):
 *   - users, policies, tags, API keys, sub-organizations
 */

export type ResourceType = "wallet" | "private_key";

export type MigrationItemStatus =
  | "discovered"
  | "export_started"
  | "exported"
  | "target_init_started"
  | "target_init_completed"
  | "import_started"
  | "imported"
  | "verified"
  | "needs_review"
  | "failed"
  | "skipped";

export interface WalletAccountSpec {
  curve: string;
  pathFormat: string;
  path: string;
  addressFormat: string;
  address?: string;
}

export interface SourceWallet {
  walletId: string;
  walletName: string;
  accounts: WalletAccountSpec[];
  exported: boolean;
  imported: boolean;
}

export interface SourcePrivateKey {
  privateKeyId: string;
  privateKeyName: string;
  publicKey: string;
  curve: string;
  addresses: Array<{ format: string; address: string }>;
  exported: boolean;
  imported: boolean;
}

export interface MigrationItem {
  id: string;
  idempotencyKey: string;
  resourceType: ResourceType;
  sourceId: string;
  sourceName: string;
  status: MigrationItemStatus;
  sourceMetadata: SourceWalletMetadata | SourcePrivateKeyMetadata;
  targetId?: string;
  targetAddresses?: string[];
  initActivityId?: string;
  importActivityId?: string;
  error?: string;
  retryCount: number;
  verifiedAt?: string;
}

export interface SourceWalletMetadata {
  type: "wallet";
  accounts: WalletAccountSpec[];
}

export interface SourcePrivateKeyMetadata {
  type: "private_key";
  publicKey: string;
  curve: string;
  addresses: Array<{ format: string; address: string }>;
}
