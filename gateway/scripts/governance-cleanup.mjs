/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { createPool, closeConnection, testConnection } = require('../src/database/index');
const { runMigrations } = require('../src/database/migrations');
const { loadConfig } = require('../src/config/env');
const { createPostgresGovernanceActionStore } = require('../src/core/governanceStore');
const { createPostgresGovernanceWriteStore } = require('../src/core/governanceWriteStore');
const { GovernanceCleanupService } = require('../src/core/governanceCleanupService');

function parseArgs(argv) {
  const flags = new Set(argv);
  const apply = flags.has('--apply');
  const dryRun = flags.has('--dry-run');

  if (apply === dryRun) {
    throw new Error('Usage: node gateway/scripts/governance-cleanup.mjs --dry-run | --apply');
  }

  return { apply };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool(config);

  try {
    await testConnection(pool);
    await runMigrations(pool);

    const governanceActionStore = createPostgresGovernanceActionStore(pool);
    const cleanupService = new GovernanceCleanupService(
      governanceActionStore,
      createPostgresGovernanceWriteStore(pool, governanceActionStore),
    );

    const result = apply
      ? await cleanupService.apply()
      : await cleanupService.dryRun();

    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      requestId: result.requestId,
      inspectedAt: result.inspectedAt,
      staleCount: result.staleCount,
      actions: result.actions.map((action) => ({
        actionId: action.actionId,
        intentKey: action.intentKey,
        category: action.category,
        contractMethod: action.contractMethod,
        status: action.status,
        createdAt: action.createdAt,
        expiresAt: action.expiresAt,
      })),
    }, null, 2));
  } finally {
    await closeConnection(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
