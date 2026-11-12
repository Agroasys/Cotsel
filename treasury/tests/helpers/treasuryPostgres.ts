/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { LedgerEntry } from '../../src/types';

type CanonicalityWriter = Pick<
  typeof import('../../src/database/queries'),
  'markLedgerEntryCanonical'
>;

const databaseDir = resolve(__dirname, '../../src/database');

export const runPostgresIntegrationTests = process.env.TREASURY_POSTGRES_TESTS === 'true';

function adminPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
}

/** Wait for caller-owned connections to close; never terminate a live fixture client. */
export async function dropTreasuryTestDatabase(admin: Pool, dbName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const active = await admin.query(
      'SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName],
    );
    if (active.rows.length === 0) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName.replace(/"/g, '""')}"`);
      return;
    }
    // Use PostgreSQL's clock so Jest fake timers cannot stall fixture teardown.
    await admin.query('SELECT pg_sleep(0.025)');
  }
  throw new Error(`Treasury fixture connections remain open for ${dbName}`);
}

/**
 * Applies the full manifest chain rather than the baseline alone: the
 * maker-checker guarantees these suites exercise live in migration 003, so a
 * baseline-only database would quietly test the schema they replaced.
 */
export async function provisionTreasuryDatabase(prefix: string): Promise<{
  dbName: string;
  cleanup: () => Promise<void>;
}> {
  const dbName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = adminPool();
  await admin.query(`CREATE DATABASE "${dbName}"`);

  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: dbName,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  try {
    const manifest = JSON.parse(readFileSync(resolve(databaseDir, 'migrations.json'), 'utf8')) as {
      migrations: Array<{ file: string }>;
    };

    for (const migration of manifest.migrations) {
      await pool.query(readFileSync(resolve(databaseDir, migration.file), 'utf8'));
    }
  } finally {
    await pool.end();
  }

  return {
    dbName,
    async cleanup() {
      try {
        await dropTreasuryTestDatabase(admin, dbName);
      } finally {
        await admin.end();
      }
    },
  };
}

export function applyTreasuryTestEnv(dbName: string): void {
  process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
  process.env.DB_PORT = process.env.DB_PORT || '5432';
  process.env.DB_NAME = dbName;
  process.env.DB_USER = process.env.DB_USER || 'postgres';
  process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
  process.env.PORT = process.env.PORT || '3200';
  process.env.INDEXER_GRAPHQL_URL =
    process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';
}

/**
 * Seeded entries start UNVERIFIED, which WP-4 B-08 keeps out of every sweep
 * decision. A suite about something other than canonicality proves its entry
 * canonical the way the verifier would, against the identity it was stored with.
 */
export async function markSeededEntryCanonical(
  queries: CanonicalityWriter,
  entry: LedgerEntry,
): Promise<void> {
  const { state } = await queries.markLedgerEntryCanonical({
    ledgerEntryId: entry.id,
    blockHash: entry.block_hash as string,
    logIndex: entry.log_index as number,
    logAddress: entry.log_address as string,
    logIdentityHash: entry.log_identity_hash as string,
    stableBlockNumber: entry.block_number + 64,
  });
  if (state !== 'CANONICAL') {
    throw new Error(`Seeded ledger entry ${entry.id} could not be marked canonical (${state})`);
  }
}
