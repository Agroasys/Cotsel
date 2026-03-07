/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { createPool, closeConnection, testConnection } from '../database/index';
import { runMigrations } from '../database/migrations';
import { loadExecutorConfig } from '../config/executorEnv';
import { createPostgresAuditLogStore } from '../core/auditLogStore';
import { createPostgresGovernanceActionStore } from '../core/governanceStore';
import { createPostgresGovernanceWriteStore } from '../core/governanceWriteStore';
import { createGovernanceStatusService } from '../core/governanceStatusService';
import { Logger } from '../logging/logger';
import {
  createPostgresGovernanceExecutionLock,
  GovernanceExecutorService,
} from './governanceExecutor';
import { createAdminSdkGovernanceChainExecutor } from './adminSdkGovernanceChainExecutor';

async function main(): Promise<void> {
  const actionId = process.argv[2]?.trim();
  if (!actionId) {
    throw new Error('Usage: npm run -w gateway execute:governance-action -- <actionId>');
  }

  const config = loadExecutorConfig();
  const pool = createPool(config);

  try {
    await testConnection(pool);
    await runMigrations(pool);

    const governanceActionStore = createPostgresGovernanceActionStore(pool);
    const service = new GovernanceExecutorService(
      governanceActionStore,
      createPostgresGovernanceWriteStore(pool, governanceActionStore),
      createPostgresAuditLogStore(pool),
      createGovernanceStatusService(config),
      createPostgresGovernanceExecutionLock(pool),
      createAdminSdkGovernanceChainExecutor(config),
    );

    const requestId = `executor-${randomUUID()}`;
    const result = await service.executeAction(actionId, requestId, requestId);

    Logger.info('Governance action executor completed', {
      requestId,
      actionId,
      status: result.status,
      txHash: result.txHash,
      proposalId: result.proposalId,
      blockNumber: result.blockNumber,
    });

    if (result.status === 'failed') {
      process.exitCode = 1;
    }
  } finally {
    await closeConnection(pool);
  }
}

main().catch((error) => {
  Logger.error('Governance action executor failed', error);
  process.exit(1);
});
