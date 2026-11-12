/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Client, Pool } from 'pg';
import { provisionTreasuryDatabase, runPostgresIntegrationTests } from './helpers/treasuryPostgres';

const describePostgres = runPostgresIntegrationTests ? describe : describe.skip;
const options = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

async function removeTestDatabase(dbName: string): Promise<void> {
  const admin = new Pool({ ...options, database: 'postgres' });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

describePostgres('treasury PostgreSQL fixture cleanup', () => {
  jest.setTimeout(30_000);

  it('allows a caller connection to close gracefully without a server termination error', async () => {
    const fixture = await provisionTreasuryDatabase('treasury_fixture_graceful');
    const client = new Client({ ...options, database: fixture.dbName });
    const errors: string[] = [];
    client.on('error', (error: Error & { code?: string }) =>
      errors.push(error.code || error.message),
    );
    await client.connect();
    await client.query('SELECT 1');
    const closed = new Promise<void>((resolve, reject) => {
      setTimeout(() => void client.end().then(resolve, reject), 250);
    });

    try {
      await fixture.cleanup();
      await closed;
      expect(errors).toEqual([]);
      const admin = new Pool({ ...options, database: 'postgres' });
      try {
        const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          fixture.dbName,
        ]);
        expect(result.rows).toHaveLength(0);
      } finally {
        await admin.end();
      }
    } finally {
      await closed;
      await removeTestDatabase(fixture.dbName);
    }
  });

  it('rejects a leaked connection instead of terminating it or treating cleanup as successful', async () => {
    const fixture = await provisionTreasuryDatabase('treasury_fixture_leaked');
    const client = new Client({ ...options, database: fixture.dbName });
    const errors: string[] = [];
    client.on('error', (error: Error & { code?: string }) =>
      errors.push(error.code || error.message),
    );
    await client.connect();

    try {
      await expect(fixture.cleanup()).rejects.toThrow(/fixture connections remain open/);
      expect((await client.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await client.end();
      await removeTestDatabase(fixture.dbName);
    }
  });
});
