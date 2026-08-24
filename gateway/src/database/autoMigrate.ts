/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { shouldAutoMigrateDatabase } from '@agroasys/shared-db';
import { GatewayConfig } from '../config/env';
import { Logger } from '../logging/logger';
import { closeConnection, createPool } from './index';
import { runMigrations } from './migrations';

export async function migrateGatewayDatabaseIfEnabled(config: GatewayConfig): Promise<void> {
  if (
    !shouldAutoMigrateDatabase({
      nodeEnv: process.env.NODE_ENV,
      rawValue: process.env.DB_AUTO_MIGRATE,
    })
  ) {
    Logger.info('Automatic database migration is disabled for gateway runtime');
    return;
  }

  const migrationPool = createPool(config, 'migration');
  try {
    await runMigrations(migrationPool);
  } finally {
    await closeConnection(migrationPool);
  }
}
