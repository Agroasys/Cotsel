import { createServicePool } from '@agroasys/shared-db';
import { assertMigrationHistory } from '@agroasys/shared-db/migrate';
import path from 'node:path';
import { config } from '../config';
import { Logger } from '../utils/logger';

const SERVICE_NAME = 'oracle';
const MIGRATION_MANIFEST_PATH = path.resolve(__dirname, 'migrations.json');

export const pool = createServicePool({
  serviceName: SERVICE_NAME,
  connectionRole: 'runtime',
  runtimeDbUser: config.dbUser,
  host: config.dbHost,
  port: config.dbPort,
  database: config.dbName,
  user: config.dbUser,
  password: config.dbPassword,
  sslMode: config.dbSslMode,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  Logger.info('New database connection established');
});

pool.on('error', (err: Error) => {
  Logger.error('Unexpected database error', err);
});

export async function testConnection(): Promise<void> {
  try {
    const result = await pool.query('SELECT NOW() as current_time');
    await assertMigrationHistory({
      pool,
      serviceName: SERVICE_NAME,
      manifestPath: MIGRATION_MANIFEST_PATH,
    });
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
