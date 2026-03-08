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
import { GovernanceMutationService } from './core/governanceMutationService';
import { createGovernanceStatusService } from './core/governanceStatusService';
import { Logger } from './logging/logger';
import { createComplianceRouter } from './routes/compliance';
import { createGovernanceRouter } from './routes/governance';
import { createGovernanceMutationRouter } from './routes/governanceMutations';

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
const governanceMutationService = new GovernanceMutationService(config, governanceActionStore, governanceWriteStore);

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

  return dependencies;
}

async function bootstrap(): Promise<void> {
  Logger.info('Initializing gateway database');
  await testConnection(pool);
  await runMigrations(pool);

  const extraRouter = Router();
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

  const shutdown = async (signal: string): Promise<void> => {
    Logger.info('Shutting down dashboard gateway', { signal });
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
    await closeConnection(pool);
    process.exit(1);
  });
}

bootstrap().catch(async (error) => {
  Logger.error('Failed to start dashboard gateway', error);
  await closeConnection(pool).catch(() => undefined);
  process.exit(1);
});
