import type { MigrationItem } from "./resources.js";

export interface MigrationManifest {
  version: "1.0.0";
  createdAt: string;
  updatedAt: string;
  sourceProvider: "turnkey";
  sourceOrgId: string;
  targetProvider: "0xkey";
  targetOrgId: string;
  targetUserId: string;
  deployment?: {
    sourceApiBaseUrl: string;
    targetApiBaseUrl: string;
    targetSignerPublicKey: string;
  };
  items: MigrationItem[];
  summary: MigrationSummary;
}

export interface MigrationSummary {
  total: number;
  discovered: number;
  imported: number;
  verified: number;
  failed: number;
  skipped: number;
  needsReview?: number;
}

/**
 * Idempotency key format:
 * `${sourceProvider}:${sourceOrgId}:${resourceType}:${sourceResourceId}:${targetOrgId}`
 *
 * This ensures the same resource is never imported twice into the same target org,
 * even across different migration runs.
 */
export function buildIdempotencyKey(
  sourceOrgId: string,
  resourceType: string,
  sourceResourceId: string,
  targetOrgId: string,
): string {
  return `turnkey:${sourceOrgId}:${resourceType}:${sourceResourceId}:${targetOrgId}`;
}
