/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { config } from '../config';
import { Logger } from '../utils/logger';

export const pool = new Pool({
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
  Logger.info('New database connection established');
});

pool.on('error', (err) => {
  Logger.error('Unexpected database error', err);
});

export async function testConnection(): Promise<void> {
  try {
    const result = await pool.query('SELECT NOW() as current_time');
    Logger.info('Database connection test successful', {
      currentTime: result.rows[0].current_time,
    });
  } catch (error) {
    Logger.error('Database connection test failed', error);
    throw error;
  }
}

export async function closeConnection(): Promise<void> {
  await pool.end();
  Logger.info('Database connection pool closed');
}
