/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createServicePool, resolveMigrationCredentials } from '@agroasys/shared-db';
import { Pool } from 'pg';
import { GatewayConfig } from '../config/env';
import { Logger } from '../logging/logger';

type PoolMode = 'runtime' | 'migration';

export function createPool(config: GatewayConfig, mode: PoolMode = 'runtime'): Pool {
  const credentials =
    mode === 'migration'
      ? resolveMigrationCredentials(config)
      : { user: config.dbUser, password: config.dbPassword };

  const pool = createServicePool({
    serviceName: 'gateway',
    connectionRole: mode,
    runtimeDbUser: config.dbUser,
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbName,
    user: credentials.user,
    password: credentials.password,
    max: mode === 'migration' ? 4 : 20,
    idleTimeoutMillis: mode === 'migration' ? 5000 : 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('connect', () => {
    Logger.debug('New database connection established');
  });

  pool.on('error', (error) => {
    Logger.error('Unexpected database error', error);
  });

  return pool;
}

export async function testConnection(pool: Pool): Promise<void> {
  await pool.query('SELECT NOW() AS current_time');
}

export async function closeConnection(pool: Pool): Promise<void> {
  await pool.end();
}
