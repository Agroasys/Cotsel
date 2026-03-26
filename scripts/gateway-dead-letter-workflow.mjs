#!/usr/bin/env node
import { createRequire } from 'module';
import { runGatewayDeadLetterWorkflow } from './lib/gateway-dead-letter-workflow-lib.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { loadConfig } = require('../gateway/src/config/env');
const { runMigrations } = require('../gateway/src/database/migrations');
const { createPool, closeConnection } = require('../gateway/src/database/index');
const { createPostgresFailedOperationStore } = require('../gateway/src/core/failedOperationStore');
const { createPostgresGovernanceActionStore } = require('../gateway/src/core/governanceStore');
const { createPostgresGovernanceWriteStore } = require('../gateway/src/core/governanceWriteStore');
const { GovernanceMutationService } = require('../gateway/src/core/governanceMutationService');
const { createPostgresComplianceStore } = require('../gateway/src/core/complianceStore');
const { createPostgresComplianceWriteStore } = require('../gateway/src/core/complianceWriteStore');
const { ComplianceService } = require('../gateway/src/core/complianceService');
const { createPostgresSettlementStore } = require('../gateway/src/core/settlementStore');
const { SettlementCallbackDispatcher } = require('../gateway/src/core/settlementCallbackDispatcher');
const { GatewayFailedOperationReplayer } = require('../gateway/src/core/errorHandlerWorkflow');

async function main() {
  const config = loadConfig();
  const pool = createPool(config);

  try {
    await runMigrations(pool);

    const failedOperationStore = createPostgresFailedOperationStore(pool);
    const governanceActionStore = createPostgresGovernanceActionStore(pool);
    const governanceWriteStore = createPostgresGovernanceWriteStore(pool, governanceActionStore);
    const governanceMutationService = new GovernanceMutationService(
      config,
      governanceActionStore,
      governanceWriteStore,
    );
    const complianceStore = createPostgresComplianceStore(pool);
    const complianceWriteStore = createPostgresComplianceWriteStore(pool, complianceStore);
    const complianceService = new ComplianceService(complianceStore, complianceWriteStore);
    const settlementStore = createPostgresSettlementStore(pool);
    const settlementCallbackDispatcher = new SettlementCallbackDispatcher(config, settlementStore);
    const replayer = new GatewayFailedOperationReplayer(
      failedOperationStore,
      governanceMutationService,
      complianceService,
      settlementCallbackDispatcher,
    );

    await runGatewayDeadLetterWorkflow(process.argv.slice(2), {
      listFailedOperations: (input) => failedOperationStore.list(input),
      replayFailedOperation: (failedOperationId) => replayer.replay(failedOperationId),
    });
  } finally {
    await closeConnection(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

