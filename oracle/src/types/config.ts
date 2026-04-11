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
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  settlementRuntimeKey?: string;
  networkName?: string;
  explorerBaseUrl?: string | null;
  oraclePrivateKey: string;

  // oracle db
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbMigrationUser?: string;
  dbMigrationPassword?: string;

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
