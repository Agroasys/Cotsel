import { createServicePool } from '@agroasys/shared-db';
import { assertMigrationHistory } from '@agroasys/shared-db/migrate';
import path from 'node:path';
import { config } from '../config';

const SERVICE_NAME = 'reconciliation';
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
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function testConnection(): Promise<void> {
  await pool.query('SELECT 1');
  await assertMigrationHistory({
    pool,
    serviceName: SERVICE_NAME,
    manifestPath: MIGRATION_MANIFEST_PATH,
  });
}

export async function closeConnection(): Promise<void> {
  await pool.end();
}
