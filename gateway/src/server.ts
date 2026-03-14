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
import { createAuthSessionClient } from './core/authSessionClient';
import { createPostgresComplianceStore } from './core/complianceStore';
import { ComplianceService } from './core/complianceService';
import { createPostgresComplianceWriteStore } from './core/complianceWriteStore';
import { createPostgresGovernanceActionStore } from './core/governanceStore';
import { createPostgresGovernanceWriteStore } from './core/governanceWriteStore';
import { createPostgresIdempotencyStore } from './core/idempotencyStore';
import { createGatewayServiceAuthNonceStore, createPostgresSettlementStore } from './core/settlementStore';
import { createServiceApiKeyLookup } from './core/serviceAuth';
import { SettlementCallbackDispatcher } from './core/settlementCallbackDispatcher';
import { SettlementService } from './core/settlementService';
import { TradeReadService } from './core/tradeReadService';
import { GovernanceMutationService } from './core/governanceMutationService';
import { createGovernanceStatusService } from './core/governanceStatusService';
import { OperationsSummaryService } from './core/operationsSummaryService';
import { OverviewService } from './core/overviewService';
import { checkIndexerHealth } from './core/indexerHealthProbe';
import { Logger } from './logging/logger';
import { createCapabilitiesRouter } from './routes/capabilities';
import { createComplianceRouter } from './routes/compliance';
import { createGovernanceRouter } from './routes/governance';
import { createGovernanceMutationRouter } from './routes/governanceMutations';
import { createOperationsRouter } from './routes/operations';
import { createOverviewRouter } from './routes/overview';
import { createSettlementRouter } from './routes/settlement';
import { createTradeRouter } from './routes/trades';

const config = loadConfig();
const pool = createPool(config);
const authSessionClient = createAuthSessionClient(config);
const complianceStore = createPostgresComplianceStore(pool);
const complianceWriteStore = createPostgresComplianceWriteStore(pool, complianceStore);
const complianceService = new ComplianceService(complianceStore, complianceWriteStore);
const governanceActionStore = createPostgresGovernanceActionStore(pool);
const governanceWriteStore = createPostgresGovernanceWriteStore(pool, governanceActionStore);
const governanceStatusService = createGovernanceStatusService(config);
const idempotencyStore = createPostgresIdempotencyStore(pool);
const settlementStore = createPostgresSettlementStore(pool);
const settlementNonceStore = createGatewayServiceAuthNonceStore(pool);
const settlementServiceApiKeyLookup = createServiceApiKeyLookup(config.settlementServiceAuthApiKeysJson);
const settlementService = new SettlementService(config, settlementStore);
const settlementCallbackDispatcher = new SettlementCallbackDispatcher(config, settlementStore);
const governanceMutationService = new GovernanceMutationService(config, governanceActionStore, governanceWriteStore);
const tradeReadService = new TradeReadService(
  config.indexerGraphqlUrl,
  config.indexerRequestTimeoutMs,
  complianceStore,
  settlementStore,
);
const overviewService = new OverviewService(
  config.indexerGraphqlUrl,
  config.indexerRequestTimeoutMs,
  governanceStatusService,
  complianceStore,
);
const oracleBaseUrl = readOptionalBaseUrl('GATEWAY_ORACLE_BASE_URL');
const reconciliationBaseUrl = readOptionalBaseUrl('GATEWAY_RECONCILIATION_BASE_URL');
const treasuryBaseUrl = readOptionalBaseUrl('GATEWAY_TREASURY_BASE_URL');
const ricardianBaseUrl = readOptionalBaseUrl('GATEWAY_RICARDIAN_BASE_URL');
const notificationsBaseUrl = readOptionalBaseUrl('GATEWAY_NOTIFICATIONS_BASE_URL');

function readOptionalBaseUrl(variableName: string): string | undefined {
  const value = process.env[variableName]?.trim();
  if (!value) {
    return undefined;
  }

  return value.replace(/\/$/, '');
}

async function checkHttpHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Probe timeout after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const operationsSummaryService = new OperationsSummaryService([
  {
    key: 'oracle',
    name: 'Oracle',
    source: 'oracle_http',
    staleAfterMs: 120_000,
    timeoutMs: 5_000,
    check: oracleBaseUrl
      ? async () => checkHttpHealth(oracleBaseUrl, 5_000)
      : undefined,
  },
  {
    key: 'indexer',
    name: 'Indexer',
    source: 'indexer_graphql',
    staleAfterMs: 120_000,
    timeoutMs: config.indexerRequestTimeoutMs,
    check: async () => checkIndexerHealth(config.indexerGraphqlUrl, config.indexerRequestTimeoutMs, 120_000),
  },
  {
    key: 'reconciliation',
    name: 'Reconciliation',
    source: 'reconciliation_http',
    staleAfterMs: 120_000,
    timeoutMs: 5_000,
    check: reconciliationBaseUrl
      ? async () => checkHttpHealth(reconciliationBaseUrl, 5_000)
      : undefined,
  },
  {
    key: 'treasury',
    name: 'Treasury',
    source: 'treasury_http',
    staleAfterMs: 120_000,
    timeoutMs: 5_000,
    check: treasuryBaseUrl
      ? async () => checkHttpHealth(treasuryBaseUrl, 5_000)
      : undefined,
  },
  {
    key: 'ricardian',
    name: 'Ricardian Engine',
    source: 'ricardian_http',
    staleAfterMs: 120_000,
    timeoutMs: 5_000,
    check: ricardianBaseUrl
      ? async () => checkHttpHealth(ricardianBaseUrl, 5_000)
      : undefined,
  },
  {
    key: 'notifications',
    name: 'Notifications',
    source: 'notifications_http',
    staleAfterMs: 120_000,
    timeoutMs: 5_000,
    check: notificationsBaseUrl
      ? async () => checkHttpHealth(notificationsBaseUrl, 5_000)
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
  extraRouter.use(createComplianceRouter({
    authSessionClient,
    config,
    complianceService,
    idempotencyStore,
  }));
  extraRouter.use(createGovernanceRouter({
    authSessionClient,
    config,
    governanceStatusService,
    governanceActionStore,
  }));
  extraRouter.use(createGovernanceMutationRouter({
    authSessionClient,
    config,
    governanceReader: governanceStatusService,
    mutationService: governanceMutationService,
    idempotencyStore,
  }));
  extraRouter.use(createTradeRouter({
    authSessionClient,
    config,
    tradeReadService,
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

  const shutdown = async (signal: string): Promise<void> => {
    Logger.info('Shutting down dashboard gateway', { signal });
    settlementCallbackDispatcher.stop();
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
    await closeConnection(pool);
    process.exit(1);
  });
}

bootstrap().catch(async (error) => {
  Logger.error('Failed to start dashboard gateway', error);
  await closeConnection(pool).catch(() => undefined);
  process.exit(1);
});
