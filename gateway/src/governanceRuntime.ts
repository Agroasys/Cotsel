/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import type { GatewayConfig } from './config/env';
import type { AuthSessionClient } from './core/authSessionClient';
import { GovernanceDirectSignMonitor } from './core/governanceDirectSignMonitor';
import { GovernanceMutationService } from './core/governanceMutationService';
import { createPostgresGovernanceActionStore } from './core/governancePostgresStore';
import { createPostgresGovernanceTransitionStore } from './core/governancePostgresTransitionStore';
import { createGovernanceStatusService } from './core/governanceStatusService';
import { createDefaultTransactionVerifier } from './core/governanceTransactionVerifier';
import { createPostgresGovernanceWriteStore } from './core/governanceWriteStore';
import type { IdempotencyStore } from './core/idempotencyStore';
import { createGovernanceRouter } from './routes/governance';

export function createGovernanceRuntime(config: GatewayConfig, pool: Pool) {
  const governanceActionStore = createPostgresGovernanceActionStore(pool);
  const governanceWriteStore = createPostgresGovernanceWriteStore(pool, governanceActionStore);
  const governanceTransitionStore = createPostgresGovernanceTransitionStore(pool);
  const verifier = createDefaultTransactionVerifier(config);
  const governanceMutationService = new GovernanceMutationService(
    config,
    governanceActionStore,
    governanceWriteStore,
    governanceTransitionStore,
    verifier,
  );
  const monitor = new GovernanceDirectSignMonitor(governanceTransitionStore, verifier);
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
