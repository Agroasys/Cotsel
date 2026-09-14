import type { PostgresSslMode } from '@agroasys/shared-db';

export interface OracleConfig {
  nodeEnv: string;
  // server
  port: number;
  apiKey: string;
  hmacSecret: string;
  corsAllowedOrigins: string[];
  corsAllowNoOrigin: boolean;
  rateLimitEnabled: boolean;
  rateLimitRedisUrl?: string;

  // network
  rpcUrl: string;
  rpcFallbackUrls: string[];
  rpcQuorum?: number;
  rpcStallTimeoutMs?: number;
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  settlementRuntimeKey?: string;
  networkName?: string;
  explorerBaseUrl?: string | null;

  // signer custody
  oracleSignerCustodyMode: 'raw_private_key' | 'kms' | 'mpc';
  oraclePrivateKey?: string;
  oracleKmsKeyId?: string;
  oracleKmsExpectedAddress?: string;
  oracleManagedSignerUrl?: string;
  oracleManagedSignerApiKey?: string;
  oracleManagedSignerRequestTimeoutMs?: number;

  // oracle db
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbSslMode: PostgresSslMode;

  // reconciliation db, read-only: the PRES-11 containment gate
  //
  // Optional so a deployment without reconciliation still starts, but once a
  // database is named the guard is mandatory and fail-closed — see
  // `core/containment-guard.ts`.
  reconciliationDbName?: string;
  reconciliationDbHost?: string;
  reconciliationDbPort?: number;
  reconciliationDbUser?: string;
  reconciliationDbPassword?: string;
  reconciliationDbSslMode?: PostgresSslMode;

  // indexer graphql api
  indexerGraphqlUrl: string;
  indexerGraphqlRequestTimeoutMs: number;

  // retry
  retryAttempts: number;
  retryDelay: number;
  hmacNonceTtlSeconds: number;

  // notifications
  notificationsEnabled: boolean;
  notificationsWebhookUrl?: string;
  notificationsCooldownMs: number;
  notificationsRequestTimeoutMs: number;

  // manual approval mode (pilot)
  manualApprovalEnabled: boolean;
}
