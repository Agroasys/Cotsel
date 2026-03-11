export interface OracleConfig {
    // server
    port: number;
    apiKey: string;
    hmacSecret: string;
    
    // network
    rpcUrl: string;
    rpcFallbackUrls: string[];
    chainId: number;
    escrowAddress: string;
    usdcAddress: string;
    oraclePrivateKey: string;
    
    // oracle db
    dbHost: string;
    dbPort: number;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    
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
