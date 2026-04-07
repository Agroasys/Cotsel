/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { runMigrations } from './database/migrations';
import { createPool, closeConnection, testConnection } from './database/index';
import { loadConfig } from './config/env';
import { createApp } from './app';
import { AccessLogService } from './core/accessLogService';
import { createPostgresAccessLogStore } from './core/accessLogStore';
import { createPostgresAuditLogStore } from './core/auditLogStore';
import { createPostgresAuditFeedStore } from './core/auditFeedStore';
import { createAuthSessionClient } from './core/authSessionClient';
import { GovernanceApprovalWorkflowReadService } from './core/approvalWorkflowReadService';
import { createPostgresComplianceStore } from './core/complianceStore';
import { ComplianceService } from './core/complianceService';
import { createPostgresComplianceWriteStore } from './core/complianceWriteStore';
import { GatewayEvidenceBundleService } from './core/evidenceBundleService';
import { createPostgresEvidenceBundleStore } from './core/evidenceBundleStore';
import { createPostgresGovernanceActionStore } from './core/governanceStore';
import { createPostgresGovernanceWriteStore } from './core/governanceWriteStore';
import { GatewayErrorHandlerWorkflow } from './core/errorHandlerWorkflow';
import { createPostgresFailedOperationStore } from './core/failedOperationStore';
import { createPostgresIdempotencyStore } from './core/idempotencyStore';
import { OperatorSettingsReadService } from './core/operatorSettingsReadService';
import { createPostgresRoleAssignmentStore } from './core/roleAssignmentStore';
import { createGatewayServiceAuthNonceStore, createPostgresSettlementStore } from './core/settlementStore';
import { createServiceApiKeyLookup } from './core/serviceAuth';
import { SettlementCallbackDispatcher } from './core/settlementCallbackDispatcher';
import { SettlementService } from './core/settlementService';
import { TradeReadService } from './core/tradeReadService';
import { IndexerGraphqlClient } from './core/indexerGraphqlClient';
import { GovernanceDirectSignMonitor } from './core/governanceDirectSignMonitor';
import { createDefaultTransactionVerifier, GovernanceMutationService } from './core/governanceMutationService';
import { createGovernanceStatusService } from './core/governanceStatusService';
import { EvidenceReadService } from './core/evidenceReadService';
import { OperationsSummaryService } from './core/operationsSummaryService';
import { OverviewService } from './core/overviewService';
import { TreasuryReadService } from './core/treasuryReadService';
import { ReconciliationReadService } from './core/reconciliationReadService';
import { RicardianClient } from './core/ricardianClient';
import { createDownstreamServiceRegistry } from './core/serviceRegistry';
import { ServiceOrchestrator } from './core/serviceOrchestrator';
import { Logger } from './logging/logger';
import { createAccessLogRouter } from './routes/accessLogs';
import { createApprovalWorkflowRouter } from './routes/approvals';
import { createCapabilitiesRouter } from './routes/capabilities';
import { createComplianceRouter } from './routes/compliance';
import { createEvidenceBundleRouter } from './routes/evidenceBundles';
import { createGovernanceRouter } from './routes/governance';
import { createGovernanceMutationRouter } from './routes/governanceMutations';
import { createOperationsRouter } from './routes/operations';
import { createOverviewRouter } from './routes/overview';
import { createReconciliationRouter } from './routes/reconciliation';
import { createRicardianRouter } from './routes/ricardian';
import { createSettingsRouter } from './routes/settings';
import { createSettlementRouter } from './routes/settlement';
import { createTreasuryRouter } from './routes/treasury';
import { createTradeRouter } from './routes/trades';

const config = loadConfig();
const pool = createPool(config);
const authSessionClient = createAuthSessionClient(config);
const accessLogStore = createPostgresAccessLogStore(pool);
const accessLogService = new AccessLogService(accessLogStore);
const auditLogStore = createPostgresAuditLogStore(pool);
const auditFeedStore = createPostgresAuditFeedStore(pool);
const complianceStore = createPostgresComplianceStore(pool);
const complianceWriteStore = createPostgresComplianceWriteStore(pool, complianceStore);
const complianceService = new ComplianceService(complianceStore, complianceWriteStore);
const evidenceBundleStore = createPostgresEvidenceBundleStore(pool);
const governanceActionStore = createPostgresGovernanceActionStore(pool);
const governanceWriteStore = createPostgresGovernanceWriteStore(pool, governanceActionStore);
const governanceStatusService = createGovernanceStatusService(config);
const approvalWorkflowReadService = new GovernanceApprovalWorkflowReadService(governanceActionStore, governanceStatusService);
const failedOperationStore = createPostgresFailedOperationStore(pool);
const errorHandlerWorkflow = new GatewayErrorHandlerWorkflow(failedOperationStore, auditLogStore);
const idempotencyStore = createPostgresIdempotencyStore(pool);
const roleAssignmentStore = createPostgresRoleAssignmentStore(pool);
const settlementStore = createPostgresSettlementStore(pool);
const settlementNonceStore = createGatewayServiceAuthNonceStore(pool);
const settlementServiceApiKeyLookup = createServiceApiKeyLookup(config.settlementServiceAuthApiKeysJson);
const settlementService = new SettlementService(config, settlementStore);
const settlementCallbackDispatcher = new SettlementCallbackDispatcher(config, settlementStore, {
  failedOperationWorkflow: errorHandlerWorkflow,
});
const governanceTransactionVerifier = createDefaultTransactionVerifier(config);
const governanceMutationService = new GovernanceMutationService(
  config,
  governanceActionStore,
  governanceWriteStore,
  governanceTransactionVerifier,
);
const governanceDirectSignMonitor = new GovernanceDirectSignMonitor(
  governanceActionStore,
  governanceWriteStore,
  auditLogStore,
  governanceTransactionVerifier,
);
const treasuryReadService = new TreasuryReadService(governanceStatusService, governanceActionStore);
const reconciliationReadService = new ReconciliationReadService(settlementStore);
const downstreamServiceRegistry = createDownstreamServiceRegistry([
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
    readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
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
    readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
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
    readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
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
    readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
    readRetryBudget: config.downstreamReadRetryBudget ?? 1,
    mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
  },
  {
    key: 'notifications',
    name: 'Notifications',
    source: 'notifications_http',
    baseUrl: config.notificationsBaseUrl,
    auth: { mode: 'none' },
    readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
    readRetryBudget: config.downstreamReadRetryBudget ?? 1,
    mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
  },
]);
const orchestrator = new ServiceOrchestrator(downstreamServiceRegistry);
const indexerClient = new IndexerGraphqlClient(
  config.indexerGraphqlUrl,
  config.indexerRequestTimeoutMs,
);
const tradeReadService = new TradeReadService(
  indexerClient,
  complianceStore,
  settlementStore,
  config.explorerBaseUrl,
);
const overviewService = new OverviewService(
  indexerClient,
  governanceStatusService,
  complianceStore,
);
const settingsReadService = new OperatorSettingsReadService(
  roleAssignmentStore,
  auditFeedStore,
);
const ricardianClient = new RicardianClient(orchestrator);
const evidenceReadService = new EvidenceReadService(
  tradeReadService,
  settlementStore,
  ricardianClient,
  complianceStore,
  governanceActionStore,
);
const evidenceBundleService = new GatewayEvidenceBundleService(
  evidenceBundleStore,
  tradeReadService,
  complianceStore,
  config.ricardianBaseUrl,
);

const operationsSummaryService = new OperationsSummaryService([
  {
    key: 'oracle',
    name: 'Oracle',
    source: 'oracle_http',
    staleAfterMs: 120_000,
    timeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    check: config.oracleBaseUrl
      ? async () => orchestrator.probeHealth('oracle')
      : undefined,
  },
  {
    key: 'indexer',
    name: 'Indexer',
    source: 'indexer_graphql',
    staleAfterMs: 120_000,
    timeoutMs: config.indexerRequestTimeoutMs,
    check: async () => indexerClient.checkHealth(120_000),
  },
  {
    key: 'reconciliation',
    name: 'Reconciliation',
    source: 'reconciliation_http',
    staleAfterMs: 120_000,
    timeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    check: config.reconciliationBaseUrl
      ? async () => orchestrator.probeHealth('reconciliation')
      : undefined,
  },
  {
    key: 'treasury',
    name: 'Treasury',
    source: 'treasury_http',
    staleAfterMs: 120_000,
    timeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    check: config.treasuryBaseUrl
      ? async () => orchestrator.probeHealth('treasury')
      : undefined,
  },
  {
    key: 'ricardian',
    name: 'Ricardian Engine',
    source: 'ricardian_http',
    staleAfterMs: 120_000,
    timeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    check: config.ricardianBaseUrl
      ? async () => orchestrator.probeHealth('ricardian')
      : undefined,
  },
  {
    key: 'notifications',
    name: 'Notifications',
    source: 'notifications_http',
    staleAfterMs: 120_000,
    timeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
    check: config.notificationsBaseUrl
      ? async () => orchestrator.probeHealth('notifications')
      : undefined,
  },
]);

function loadPackageVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../package.json'),
    path.resolve(process.cwd(), 'gateway/package.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
    if (parsed.version) {
      return parsed.version;
    }
  }

  return '0.1.0';
}

async function readinessCheck() {
  const requestId = `readyz-${Date.now()}`;
  const dependencies = [] as { name: string; status: 'ok' | 'degraded' | 'unavailable'; detail?: string }[];

  try {
    await testConnection(pool);
    dependencies.push({ name: 'postgres', status: 'ok' });
  } catch (error) {
    dependencies.push({
      name: 'postgres',
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'Database connection failed',
    });
  }

  try {
    await authSessionClient.checkReadiness(requestId);
    dependencies.push({ name: 'auth-service', status: 'ok' });
  } catch (error) {
    dependencies.push({
      name: 'auth-service',
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'Auth service unavailable',
    });
  }

  try {
    await governanceStatusService.checkReadiness();
    dependencies.push({ name: 'chain-rpc', status: 'ok' });
  } catch (error) {
    dependencies.push({
      name: 'chain-rpc',
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'Chain RPC unavailable',
    });
  }

  try {
    await tradeReadService.checkReadiness();
    dependencies.push({ name: 'indexer-graphql', status: 'ok' });
  } catch (error) {
    dependencies.push({
      name: 'indexer-graphql',
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'Indexer GraphQL unavailable',
    });
  }

  return dependencies;
}

async function bootstrap(): Promise<void> {
  Logger.info('Initializing gateway database');
  await testConnection(pool);
  await runMigrations(pool);

  const extraRouter = Router();
  extraRouter.use(createCapabilitiesRouter({
    authSessionClient,
    config,
  }));
  extraRouter.use(createApprovalWorkflowRouter({
    authSessionClient,
    config,
    approvalWorkflowReadService,
  }));
  extraRouter.use(createAccessLogRouter({
    authSessionClient,
    config,
    accessLogService,
    idempotencyStore,
  }));
  extraRouter.use(createComplianceRouter({
    authSessionClient,
    config,
    complianceService,
    idempotencyStore,
    failedOperationWorkflow: errorHandlerWorkflow,
  }));
  extraRouter.use(createEvidenceBundleRouter({
    authSessionClient,
    config,
    evidenceBundleService,
    idempotencyStore,
  }));
  extraRouter.use(createGovernanceRouter({
    authSessionClient,
    config,
    governanceStatusService,
    governanceActionStore,
  }));
  extraRouter.use(createTreasuryRouter({
    authSessionClient,
    config,
    treasuryReadService,
  }));
  extraRouter.use(createGovernanceMutationRouter({
    authSessionClient,
    config,
    governanceReader: governanceStatusService,
    mutationService: governanceMutationService,
    idempotencyStore,
    failedOperationWorkflow: errorHandlerWorkflow,
  }));
  extraRouter.use(createTradeRouter({
    authSessionClient,
    config,
    tradeReadService,
  }));
  extraRouter.use(createReconciliationRouter({
    authSessionClient,
    config,
    reconciliationReadService,
  }));
  extraRouter.use(createRicardianRouter({
    authSessionClient,
    config,
    evidenceReadService,
  }));
  extraRouter.use(createSettingsRouter({
    authSessionClient,
    config,
    settingsReadService,
  }));
  extraRouter.use(createSettlementRouter({
    config,
    settlementService,
    settlementStore,
    nonceStore: settlementNonceStore,
    idempotencyStore,
    lookupServiceApiKey: settlementServiceApiKeyLookup,
  }));
  extraRouter.use(createOverviewRouter({
    authSessionClient,
    config,
    overviewService,
  }));
  extraRouter.use(createOperationsRouter({
    authSessionClient,
    config,
    operationsSummaryService,
  }));

  const app = createApp(config, {
    version: loadPackageVersion(),
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck,
    extraRouter,
  });

  const server = app.listen(config.port, () => {
    Logger.info('Dashboard gateway started', {
      route: '/api/dashboard-gateway/v1',
      port: config.port,
      authBaseUrl: config.authBaseUrl,
      mutationsEnabled: config.enableMutations,
      allowlistSize: config.writeAllowlist.length,
    });
  });
  settlementCallbackDispatcher.start();
  governanceDirectSignMonitor.start();

  const shutdown = async (signal: string): Promise<void> => {
    Logger.info('Shutting down dashboard gateway', { signal });
    settlementCallbackDispatcher.stop();
    governanceDirectSignMonitor.stop();
    await closeConnection(pool);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  server.on('error', async (error) => {
    Logger.error('Dashboard gateway server error', error);
    settlementCallbackDispatcher.stop();
    governanceDirectSignMonitor.stop();
    await closeConnection(pool);
    process.exit(1);
  });
}

bootstrap().catch(async (error) => {
  Logger.error('Failed to start dashboard gateway', error);
  await closeConnection(pool).catch(() => undefined);
  process.exit(1);
});
