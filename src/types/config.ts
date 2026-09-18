export interface SourceConfig {
  provider: "turnkey";
  apiBaseUrl: string;
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
}

export interface TargetConfig {
  provider: "0xkey";
  apiBaseUrl: string;
  organizationId: string;
  userId: string;
  signerPublicKey: string;
  apiPublicKey: string;
  apiPrivateKey: string;
}

export type WalletFilter = "all" | string[];
export type PrivateKeyFilter = "all" | string[];

export interface ResourcesConfig {
  wallets: WalletFilter;
  privateKeys: PrivateKeyFilter;
  mnemonicLanguage?: string;
}

export interface StateConfig {
  manifestPath: string;
}

export interface MigrationConfig {
  source: SourceConfig;
  target: TargetConfig;
  resources: ResourcesConfig;
  state: StateConfig;
}
