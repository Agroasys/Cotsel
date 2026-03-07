/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { GatewayConfig } from '../config/env';
import { Logger } from '../logging/logger';

export function createPool(config: GatewayConfig): Pool {
  const pool = new Pool({
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbName,
    user: config.dbUser,
    password: config.dbPassword,
    max: 20,
    idleTimeoutMillis: 30000,
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
