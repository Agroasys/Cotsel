/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createServicePool } from '@agroasys/shared-db';
import { assertMigrationHistory } from '@agroasys/shared-db/migrate';
import path from 'node:path';
import { Pool } from 'pg';
import { GatewayConfig } from '../config/env';
import { Logger } from '../logging/logger';

const MIGRATION_MANIFEST_PATH = path.resolve(__dirname, 'migrations.json');

export function createPool(config: GatewayConfig): Pool {
  const pool = createServicePool({
    serviceName: 'gateway',
    connectionRole: 'runtime',
    runtimeDbUser: config.dbUser,
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbName,
    user: config.dbUser,
    password: config.dbPassword,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    sslMode: config.dbSslMode,
  });

  pool.on('connect', () => {
    Logger.debug('New database connection established');
  });

  pool.on('error', (error: Error) => {
    Logger.error('Unexpected database error', error);
  });

  return pool;
}

export async function testConnection(pool: Pool): Promise<void> {
  await pool.query('SELECT NOW() AS current_time');
  await assertMigrationHistory({
    pool,
    serviceName: 'gateway',
    manifestPath: MIGRATION_MANIFEST_PATH,
  });
}

export async function closeConnection(pool: Pool): Promise<void> {
  await pool.end();
}
