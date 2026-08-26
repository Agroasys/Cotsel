import { createServicePool } from '@agroasys/shared-db';
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
  sslMode: config.dbSslMode,
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
