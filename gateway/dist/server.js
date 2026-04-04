"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const express_1 = require("express");
const migrations_1 = require("./database/migrations");
const index_1 = require("./database/index");
const env_1 = require("./config/env");
const app_1 = require("./app");
const accessLogService_1 = require("./core/accessLogService");
const accessLogStore_1 = require("./core/accessLogStore");
const auditLogStore_1 = require("./core/auditLogStore");
const auditFeedStore_1 = require("./core/auditFeedStore");
const authSessionClient_1 = require("./core/authSessionClient");
const approvalWorkflowReadService_1 = require("./core/approvalWorkflowReadService");
const complianceStore_1 = require("./core/complianceStore");
const complianceService_1 = require("./core/complianceService");
const complianceWriteStore_1 = require("./core/complianceWriteStore");
const evidenceBundleService_1 = require("./core/evidenceBundleService");
const evidenceBundleStore_1 = require("./core/evidenceBundleStore");
const governanceStore_1 = require("./core/governanceStore");
const governanceWriteStore_1 = require("./core/governanceWriteStore");
const errorHandlerWorkflow_1 = require("./core/errorHandlerWorkflow");
const failedOperationStore_1 = require("./core/failedOperationStore");
const idempotencyStore_1 = require("./core/idempotencyStore");
const operatorSettingsReadService_1 = require("./core/operatorSettingsReadService");
const roleAssignmentStore_1 = require("./core/roleAssignmentStore");
const settlementStore_1 = require("./core/settlementStore");
const serviceAuth_1 = require("./core/serviceAuth");
const settlementCallbackDispatcher_1 = require("./core/settlementCallbackDispatcher");
const settlementService_1 = require("./core/settlementService");
const tradeReadService_1 = require("./core/tradeReadService");
const indexerGraphqlClient_1 = require("./core/indexerGraphqlClient");
const governanceMutationService_1 = require("./core/governanceMutationService");
const governanceStatusService_1 = require("./core/governanceStatusService");
const evidenceReadService_1 = require("./core/evidenceReadService");
const operationsSummaryService_1 = require("./core/operationsSummaryService");
const overviewService_1 = require("./core/overviewService");
const treasuryReadService_1 = require("./core/treasuryReadService");
const reconciliationReadService_1 = require("./core/reconciliationReadService");
const ricardianClient_1 = require("./core/ricardianClient");
const serviceRegistry_1 = require("./core/serviceRegistry");
const serviceOrchestrator_1 = require("./core/serviceOrchestrator");
const logger_1 = require("./logging/logger");
const accessLogs_1 = require("./routes/accessLogs");
const approvals_1 = require("./routes/approvals");
const capabilities_1 = require("./routes/capabilities");
const compliance_1 = require("./routes/compliance");
const evidenceBundles_1 = require("./routes/evidenceBundles");
const governance_1 = require("./routes/governance");
const governanceMutations_1 = require("./routes/governanceMutations");
const operations_1 = require("./routes/operations");
const overview_1 = require("./routes/overview");
const reconciliation_1 = require("./routes/reconciliation");
const ricardian_1 = require("./routes/ricardian");
const settings_1 = require("./routes/settings");
const settlement_1 = require("./routes/settlement");
const treasury_1 = require("./routes/treasury");
const trades_1 = require("./routes/trades");
const config = (0, env_1.loadConfig)();
const pool = (0, index_1.createPool)(config);
const authSessionClient = (0, authSessionClient_1.createAuthSessionClient)(config);
const accessLogStore = (0, accessLogStore_1.createPostgresAccessLogStore)(pool);
const accessLogService = new accessLogService_1.AccessLogService(accessLogStore);
const auditLogStore = (0, auditLogStore_1.createPostgresAuditLogStore)(pool);
const auditFeedStore = (0, auditFeedStore_1.createPostgresAuditFeedStore)(pool);
const complianceStore = (0, complianceStore_1.createPostgresComplianceStore)(pool);
const complianceWriteStore = (0, complianceWriteStore_1.createPostgresComplianceWriteStore)(pool, complianceStore);
const complianceService = new complianceService_1.ComplianceService(complianceStore, complianceWriteStore);
const evidenceBundleStore = (0, evidenceBundleStore_1.createPostgresEvidenceBundleStore)(pool);
const governanceActionStore = (0, governanceStore_1.createPostgresGovernanceActionStore)(pool);
const governanceWriteStore = (0, governanceWriteStore_1.createPostgresGovernanceWriteStore)(pool, governanceActionStore);
const governanceStatusService = (0, governanceStatusService_1.createGovernanceStatusService)(config);
const approvalWorkflowReadService = new approvalWorkflowReadService_1.GovernanceApprovalWorkflowReadService(governanceActionStore, governanceStatusService);
const failedOperationStore = (0, failedOperationStore_1.createPostgresFailedOperationStore)(pool);
const errorHandlerWorkflow = new errorHandlerWorkflow_1.GatewayErrorHandlerWorkflow(failedOperationStore, auditLogStore);
const idempotencyStore = (0, idempotencyStore_1.createPostgresIdempotencyStore)(pool);
const roleAssignmentStore = (0, roleAssignmentStore_1.createPostgresRoleAssignmentStore)(pool);
const settlementStore = (0, settlementStore_1.createPostgresSettlementStore)(pool);
const settlementNonceStore = (0, settlementStore_1.createGatewayServiceAuthNonceStore)(pool);
const settlementServiceApiKeyLookup = (0, serviceAuth_1.createServiceApiKeyLookup)(config.settlementServiceAuthApiKeysJson);
const settlementService = new settlementService_1.SettlementService(config, settlementStore);
const settlementCallbackDispatcher = new settlementCallbackDispatcher_1.SettlementCallbackDispatcher(config, settlementStore, {
    failedOperationWorkflow: errorHandlerWorkflow,
});
const governanceMutationService = new governanceMutationService_1.GovernanceMutationService(config, governanceActionStore, governanceWriteStore);
const treasuryReadService = new treasuryReadService_1.TreasuryReadService(governanceStatusService, governanceActionStore);
const reconciliationReadService = new reconciliationReadService_1.ReconciliationReadService(settlementStore);
const downstreamServiceRegistry = (0, serviceRegistry_1.createDownstreamServiceRegistry)([
    {
        key: 'oracle',
        name: 'Oracle',
        source: 'oracle_http',
        baseUrl: config.oracleBaseUrl,
        healthPath: '/api/oracle/health',
        auth: config.oracleServiceApiSecret
            ? {
                mode: 'oracle_legacy_hmac',
                headerStyle: 'legacy',
                apiKey: config.oracleServiceApiKey,
                apiSecret: config.oracleServiceApiSecret,
            }
            : { mode: 'none' },
        readTimeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8000,
        readRetryBudget: config.downstreamReadRetryBudget ?? 1,
        mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
    {
        key: 'treasury',
        name: 'Treasury',
        source: 'treasury_http',
        baseUrl: config.treasuryBaseUrl,
        healthPath: '/api/treasury/v1/health',
        auth: config.treasuryServiceApiSecret
            ? {
                mode: 'shared_hmac',
                headerStyle: 'agroasys',
                apiKey: config.treasuryServiceApiKey,
                apiSecret: config.treasuryServiceApiSecret,
            }
            : { mode: 'none' },
        readTimeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8000,
        readRetryBudget: config.downstreamReadRetryBudget ?? 1,
        mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
    {
        key: 'reconciliation',
        name: 'Reconciliation',
        source: 'reconciliation_http',
        baseUrl: config.reconciliationBaseUrl,
        healthPath: '/health',
        auth: { mode: 'none' },
        readTimeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8000,
        readRetryBudget: config.downstreamReadRetryBudget ?? 1,
        mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
    {
        key: 'ricardian',
        name: 'Ricardian Engine',
        source: 'ricardian_http',
        baseUrl: config.ricardianBaseUrl,
        healthPath: '/api/ricardian/v1/health',
        auth: config.ricardianServiceApiSecret
            ? {
                mode: 'shared_hmac',
                headerStyle: 'agroasys',
                apiKey: config.ricardianServiceApiKey,
                apiSecret: config.ricardianServiceApiSecret,
            }
            : { mode: 'none' },
        readTimeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8000,
        readRetryBudget: config.downstreamReadRetryBudget ?? 1,
        mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
    {
        key: 'notifications',
        name: 'Notifications',
        source: 'notifications_http',
        baseUrl: config.notificationsBaseUrl,
        auth: { mode: 'none' },
        readTimeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8000,
        readRetryBudget: config.downstreamReadRetryBudget ?? 1,
        mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
]);
const orchestrator = new serviceOrchestrator_1.ServiceOrchestrator(downstreamServiceRegistry);
const indexerClient = new indexerGraphqlClient_1.IndexerGraphqlClient(config.indexerGraphqlUrl, config.indexerRequestTimeoutMs);
const tradeReadService = new tradeReadService_1.TradeReadService(indexerClient, complianceStore, settlementStore, config.explorerBaseUrl);
const overviewService = new overviewService_1.OverviewService(indexerClient, governanceStatusService, complianceStore);
const settingsReadService = new operatorSettingsReadService_1.OperatorSettingsReadService(roleAssignmentStore, auditFeedStore);
const ricardianClient = new ricardianClient_1.RicardianClient(orchestrator);
const evidenceReadService = new evidenceReadService_1.EvidenceReadService(tradeReadService, settlementStore, ricardianClient, complianceStore, governanceActionStore);
const evidenceBundleService = new evidenceBundleService_1.GatewayEvidenceBundleService(evidenceBundleStore, tradeReadService, complianceStore, config.ricardianBaseUrl);
const operationsSummaryService = new operationsSummaryService_1.OperationsSummaryService([
    {
        key: 'oracle',
        name: 'Oracle',
        source: 'oracle_http',
        staleAfterMs: 120000,
        timeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        check: config.oracleBaseUrl
            ? async () => orchestrator.probeHealth('oracle')
            : undefined,
    },
    {
        key: 'indexer',
        name: 'Indexer',
        source: 'indexer_graphql',
        staleAfterMs: 120000,
        timeoutMs: config.indexerRequestTimeoutMs,
        check: async () => indexerClient.checkHealth(120000),
    },
    {
        key: 'reconciliation',
        name: 'Reconciliation',
        source: 'reconciliation_http',
        staleAfterMs: 120000,
        timeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        check: config.reconciliationBaseUrl
            ? async () => orchestrator.probeHealth('reconciliation')
            : undefined,
    },
    {
        key: 'treasury',
        name: 'Treasury',
        source: 'treasury_http',
        staleAfterMs: 120000,
        timeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        check: config.treasuryBaseUrl
            ? async () => orchestrator.probeHealth('treasury')
            : undefined,
    },
    {
        key: 'ricardian',
        name: 'Ricardian Engine',
        source: 'ricardian_http',
        staleAfterMs: 120000,
        timeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        check: config.ricardianBaseUrl
            ? async () => orchestrator.probeHealth('ricardian')
            : undefined,
    },
    {
        key: 'notifications',
        name: 'Notifications',
        source: 'notifications_http',
        staleAfterMs: 120000,
        timeoutMs: config.downstreamReadTimeoutMs ?? 5000,
        check: config.notificationsBaseUrl
            ? async () => orchestrator.probeHealth('notifications')
            : undefined,
    },
]);
function loadPackageVersion() {
    const candidates = [
        path_1.default.resolve(__dirname, '../package.json'),
        path_1.default.resolve(process.cwd(), 'gateway/package.json'),
    ];
    for (const candidate of candidates) {
        if (!fs_1.default.existsSync(candidate)) {
            continue;
        }
        const parsed = JSON.parse(fs_1.default.readFileSync(candidate, 'utf8'));
        if (parsed.version) {
            return parsed.version;
        }
    }
    return '0.1.0';
}
async function readinessCheck() {
    const requestId = `readyz-${Date.now()}`;
    const dependencies = [];
    try {
        await (0, index_1.testConnection)(pool);
        dependencies.push({ name: 'postgres', status: 'ok' });
    }
    catch (error) {
        dependencies.push({
            name: 'postgres',
            status: 'unavailable',
            detail: error instanceof Error ? error.message : 'Database connection failed',
        });
    }
    try {
        await authSessionClient.checkReadiness(requestId);
        dependencies.push({ name: 'auth-service', status: 'ok' });
    }
    catch (error) {
        dependencies.push({
            name: 'auth-service',
            status: 'unavailable',
            detail: error instanceof Error ? error.message : 'Auth service unavailable',
        });
    }
    try {
        await governanceStatusService.checkReadiness();
        dependencies.push({ name: 'chain-rpc', status: 'ok' });
    }
    catch (error) {
        dependencies.push({
            name: 'chain-rpc',
            status: 'unavailable',
            detail: error instanceof Error ? error.message : 'Chain RPC unavailable',
        });
    }
    try {
        await tradeReadService.checkReadiness();
        dependencies.push({ name: 'indexer-graphql', status: 'ok' });
    }
    catch (error) {
        dependencies.push({
            name: 'indexer-graphql',
            status: 'unavailable',
            detail: error instanceof Error ? error.message : 'Indexer GraphQL unavailable',
        });
    }
    return dependencies;
}
async function bootstrap() {
    logger_1.Logger.info('Initializing gateway database');
    await (0, index_1.testConnection)(pool);
    await (0, migrations_1.runMigrations)(pool);
    const extraRouter = (0, express_1.Router)();
    extraRouter.use((0, capabilities_1.createCapabilitiesRouter)({
        authSessionClient,
        config,
    }));
    extraRouter.use((0, approvals_1.createApprovalWorkflowRouter)({
        authSessionClient,
        config,
        approvalWorkflowReadService,
    }));
    extraRouter.use((0, accessLogs_1.createAccessLogRouter)({
        authSessionClient,
        config,
        accessLogService,
        idempotencyStore,
    }));
    extraRouter.use((0, compliance_1.createComplianceRouter)({
        authSessionClient,
        config,
        complianceService,
        idempotencyStore,
        failedOperationWorkflow: errorHandlerWorkflow,
    }));
    extraRouter.use((0, evidenceBundles_1.createEvidenceBundleRouter)({
        authSessionClient,
        config,
        evidenceBundleService,
        idempotencyStore,
    }));
    extraRouter.use((0, governance_1.createGovernanceRouter)({
        authSessionClient,
        config,
        governanceStatusService,
        governanceActionStore,
    }));
    extraRouter.use((0, treasury_1.createTreasuryRouter)({
        authSessionClient,
        config,
        treasuryReadService,
    }));
    extraRouter.use((0, governanceMutations_1.createGovernanceMutationRouter)({
        authSessionClient,
        config,
        governanceReader: governanceStatusService,
        mutationService: governanceMutationService,
        idempotencyStore,
        failedOperationWorkflow: errorHandlerWorkflow,
    }));
    extraRouter.use((0, trades_1.createTradeRouter)({
        authSessionClient,
        config,
        tradeReadService,
    }));
    extraRouter.use((0, reconciliation_1.createReconciliationRouter)({
        authSessionClient,
        config,
        reconciliationReadService,
    }));
    extraRouter.use((0, ricardian_1.createRicardianRouter)({
        authSessionClient,
        config,
        evidenceReadService,
    }));
    extraRouter.use((0, settings_1.createSettingsRouter)({
        authSessionClient,
        config,
        settingsReadService,
    }));
    extraRouter.use((0, settlement_1.createSettlementRouter)({
        config,
        settlementService,
        settlementStore,
        nonceStore: settlementNonceStore,
        idempotencyStore,
        lookupServiceApiKey: settlementServiceApiKeyLookup,
    }));
    extraRouter.use((0, overview_1.createOverviewRouter)({
        authSessionClient,
        config,
        overviewService,
    }));
    extraRouter.use((0, operations_1.createOperationsRouter)({
        authSessionClient,
        config,
        operationsSummaryService,
    }));
    const app = (0, app_1.createApp)(config, {
        version: loadPackageVersion(),
        commitSha: config.commitSha,
        buildTime: config.buildTime,
        readinessCheck,
        extraRouter,
    });
    const server = app.listen(config.port, () => {
        logger_1.Logger.info('Dashboard gateway started', {
            route: '/api/dashboard-gateway/v1',
            port: config.port,
            authBaseUrl: config.authBaseUrl,
            mutationsEnabled: config.enableMutations,
            allowlistSize: config.writeAllowlist.length,
        });
    });
    settlementCallbackDispatcher.start();
    const shutdown = async (signal) => {
        logger_1.Logger.info('Shutting down dashboard gateway', { signal });
        settlementCallbackDispatcher.stop();
        await (0, index_1.closeConnection)(pool);
        server.close(() => process.exit(0));
    };
    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });
    server.on('error', async (error) => {
        logger_1.Logger.error('Dashboard gateway server error', error);
        settlementCallbackDispatcher.stop();
        await (0, index_1.closeConnection)(pool);
        process.exit(1);
    });
}
bootstrap().catch(async (error) => {
    logger_1.Logger.error('Failed to start dashboard gateway', error);
    await (0, index_1.closeConnection)(pool).catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=server.js.map