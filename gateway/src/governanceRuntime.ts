/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import type { GatewayConfig } from './config/env';
import type { AuditLogStore } from './core/auditLogStore';
import type { AuthSessionClient } from './core/authSessionClient';
import { GovernanceDirectSignMonitor } from './core/governanceDirectSignMonitor';
import { GovernanceMutationService } from './core/governanceMutationService';
import { createPostgresGovernanceActionStore } from './core/governancePostgresStore';
import { createGovernanceStatusService } from './core/governanceStatusService';
import { createDefaultTransactionVerifier } from './core/governanceTransactionVerifier';
import { createPostgresGovernanceWriteStore } from './core/governanceWriteStore';
import type { IdempotencyStore } from './core/idempotencyStore';
import { createGovernanceRouter } from './routes/governance';

export function createGovernanceRuntime(
  config: GatewayConfig,
  pool: Pool,
  auditLogStore: AuditLogStore,
) {
  const governanceActionStore = createPostgresGovernanceActionStore(pool);
  const governanceWriteStore = createPostgresGovernanceWriteStore(pool, governanceActionStore);
  const verifier = createDefaultTransactionVerifier(config);
  const governanceMutationService = new GovernanceMutationService(
    config,
    governanceActionStore,
    governanceWriteStore,
    verifier,
  );
  const monitor = new GovernanceDirectSignMonitor(
    governanceActionStore,
    governanceWriteStore,
    auditLogStore,
    verifier,
  );
  const governanceStatusService = createGovernanceStatusService(config);

  return {
    governanceStatusService,
    createRouter: (authSessionClient: AuthSessionClient, idempotencyStore: IdempotencyStore) =>
      createGovernanceRouter({
        authSessionClient,
        config,
        governanceStatusService,
        governanceActionStore,
        governanceMutationService,
        idempotencyStore,
      }),
    start: () => monitor.start(),
    stop: () => monitor.stop(),
  };
}
