import { createServicePool, resolveMigrationCredentials } from '@agroasys/shared-db';
import { Pool } from 'pg';
import { config } from '../config';

const SERVICE_NAME = 'ricardian';

export const pool = createServicePool({
  serviceName: SERVICE_NAME,
  connectionRole: 'runtime',
  runtimeDbUser: config.dbUser,
  host: config.dbHost,
  port: config.dbPort,
  database: config.dbName,
  user: config.dbUser,
  password: config.dbPassword,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function testConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function closeConnection(): Promise<void> {
  await pool.end();
}

export function createMigrationPool(): Pool {
  const credentials = resolveMigrationCredentials(config);

  return createServicePool({
    serviceName: SERVICE_NAME,
    connectionRole: 'migration',
    runtimeDbUser: config.dbUser,
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbName,
    user: credentials.user,
    password: credentials.password,
    max: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });
}
