/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { createPostgresProfileStore } from '../src/core/profileStore';
import { createPostgresSessionStore, hashSessionToken } from '../src/core/sessionStore';
import { createSessionService } from '../src/core/sessionService';
import { dockerAvailable, withPostgres } from './helpers/adminControlsIntegrationHarness';

const LIFETIME = { ttlSeconds: 3600, absoluteLifetimeSeconds: 86400 };
const SCHEMA_ROOT = path.resolve(__dirname, '../src/database');

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function createService(pool: Pool) {
  return createSessionService(
    createPostgresSessionStore(pool),
    createPostgresProfileStore(pool),
    LIFETIME,
  );
}

async function issue(pool: Pool, accountId = 'agroasys-user:lineage-1') {
  return createService(pool).issueTrustedSession({
    accountId,
    role: 'buyer',
    email: 'lineage@example.com',
    walletAddress: null,
  });
}

async function lockSessionRow(pool: Pool, tokenHash: string): Promise<PoolClient> {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query(`SELECT 1 FROM user_sessions WHERE session_token_hash = $1 FOR UPDATE`, [
    tokenHash,
  ]);
  return holder;
}

async function waitForRowLockWaiter(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`,
    );
    if (waiting.rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('refresh never waited on the parent row lock');
}

/**
 * Starts a refresh while the parent is still valid, holds its row lock until
 * `releaseAt` (epoch seconds) has passed, then settles the refresh.
 */
async function refreshAcrossLockWait(
  pool: Pool,
  sessionToken: string,
  releaseAt: number,
): Promise<PromiseSettledResult<unknown>> {
  const holder = await lockSessionRow(pool, hashSessionToken(sessionToken));
  try {
    const refresh = createService(pool).refresh(sessionToken);
    const settled = Promise.allSettled([refresh]).then(([outcome]) => outcome);
    await waitForRowLockWaiter(pool);
    await new Promise((resolve) => setTimeout(resolve, (releaseAt - Date.now() / 1000) * 1000));
    await holder.query('COMMIT');
    return await settled;
  } finally {
    holder.release();
  }
}

describe('session lineage persistence integration', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'stores only a token verifier that cannot itself authenticate',
    async () => {
      await withPostgres(async (pool) => {
        const service = createService(pool);
        const session = await issue(pool);

        const rows = await pool.query(`SELECT * FROM user_sessions`);
        expect(rows.rows).toHaveLength(1);
        expect(JSON.stringify(rows.rows)).not.toContain(session.sessionId);
        expect(rows.rows[0].session_token_hash).toBe(hashSessionToken(session.sessionId));

        await expect(service.resolve(session.sessionId)).resolves.not.toBeNull();
        await expect(service.resolve(rows.rows[0].session_token_hash)).resolves.toBeNull();
      });
    },
    120000,
  );

  integrationTest(
    'concurrent refreshes produce exactly one successor and one active session',
    async () => {
      await withPostgres(async (pool) => {
        const service = createService(pool);
        const session = await issue(pool);

        const outcomes = await Promise.allSettled(
          Array.from({ length: 8 }, () => service.refresh(session.sessionId)),
        );
        const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        expect(fulfilled).toHaveLength(1);

        const successors = await pool.query(
          `SELECT session_token_hash FROM user_sessions WHERE parent_session_token_hash = $1`,
          [hashSessionToken(session.sessionId)],
        );
        expect(successors.rows).toHaveLength(1);
        const active = await pool.query(
          `SELECT COUNT(*)::int AS count FROM user_sessions WHERE revoked_at IS NULL`,
        );
        expect(active.rows[0].count).toBe(1);

        await expect(service.resolve(session.sessionId)).resolves.toBeNull();
        const successor = (fulfilled[0] as PromiseFulfilledResult<{ sessionId: string }>).value;
        await expect(service.resolve(successor.sessionId)).resolves.not.toBeNull();
        await expect(service.refresh(session.sessionId)).rejects.toThrow(
          'invalid, expired, or revoked',
        );
      });
    },
    120000,
  );

  integrationTest(
    'a failure while issuing the successor leaves the original session intact',
    async () => {
      await withPostgres(async (pool) => {
        const service = createService(pool);
        const session = await issue(pool);

        await pool.query(`
          CREATE FUNCTION fail_session_successor() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'injected successor failure';
          END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER fail_session_successor BEFORE INSERT ON user_sessions
            FOR EACH ROW WHEN (NEW.parent_session_token_hash IS NOT NULL)
            EXECUTE FUNCTION fail_session_successor();
        `);
        await expect(service.refresh(session.sessionId)).rejects.toThrow(
          'injected successor failure',
        );

        const parent = await pool.query(
          `SELECT revoked_at FROM user_sessions WHERE session_token_hash = $1`,
          [hashSessionToken(session.sessionId)],
        );
        expect(parent.rows[0].revoked_at).toBeNull();
        const count = await pool.query(`SELECT COUNT(*)::int AS count FROM user_sessions`);
        expect(count.rows[0].count).toBe(1);

        await pool.query(`DROP TRIGGER fail_session_successor ON user_sessions`);
        await expect(service.refresh(session.sessionId)).resolves.toMatchObject({
          sessionId: expect.any(String),
        });
      });
    },
    120000,
  );

  integrationTest(
    'refresh never extends a lineage beyond its absolute lifetime',
    async () => {
      await withPostgres(async (pool) => {
        const service = createService(pool);
        const first = await issue(pool);
        const firstHash = hashSessionToken(first.sessionId);

        const lineageStart = nowSeconds() - LIFETIME.absoluteLifetimeSeconds + 600;
        await pool.query(
          `UPDATE user_sessions SET lineage_started_at = $1::bigint, issued_at = $1::bigint + 1
           WHERE session_token_hash = $2`,
          [lineageStart, firstHash],
        );
        const capped = await service.refresh(first.sessionId);
        expect(capped.expiresAt).toBe(lineageStart + LIFETIME.absoluteLifetimeSeconds);

        const successor = await pool.query(
          `SELECT lineage_started_at FROM user_sessions WHERE session_token_hash = $1`,
          [hashSessionToken(capped.sessionId)],
        );
        expect(Number(successor.rows[0].lineage_started_at)).toBe(lineageStart);

        const exhausted = await issue(pool, 'agroasys-user:lineage-2');
        const exhaustedStart = nowSeconds() - LIFETIME.absoluteLifetimeSeconds - 1;
        await pool.query(
          `UPDATE user_sessions SET lineage_started_at = $1::bigint, issued_at = $1::bigint + 1
           WHERE session_token_hash = $2`,
          [exhaustedStart, hashSessionToken(exhausted.sessionId)],
        );
        await expect(service.refresh(exhausted.sessionId)).rejects.toThrow('lifetime is exhausted');
        await expect(service.resolve(exhausted.sessionId)).resolves.not.toBeNull();
      });
    },
    120000,
  );

  integrationTest(
    'a refresh that waits on the row lock past parent expiry is refused',
    async () => {
      await withPostgres(async (pool) => {
        const session = await issue(pool);
        const tokenHash = hashSessionToken(session.sessionId);
        const parentExpiresAt = nowSeconds() + 2;
        await pool.query(
          `UPDATE user_sessions SET expires_at = $1::bigint WHERE session_token_hash = $2`,
          [parentExpiresAt, tokenHash],
        );

        const outcome = await refreshAcrossLockWait(pool, session.sessionId, parentExpiresAt + 1);
        expect(outcome.status).toBe('rejected');
        expect((outcome as PromiseRejectedResult).reason.message).toContain(
          'invalid, expired, or revoked',
        );

        const rows = await pool.query(`SELECT revoked_at FROM user_sessions`);
        expect(rows.rows).toEqual([{ revoked_at: null }]);
      });
    },
    120000,
  );

  integrationTest(
    'a refresh that waits on the row lock past the lineage bound is refused',
    async () => {
      await withPostgres(async (pool) => {
        const session = await issue(pool);
        const lineageEndsAt = nowSeconds() + 2;
        const lineageStart = lineageEndsAt - LIFETIME.absoluteLifetimeSeconds;
        await pool.query(
          `UPDATE user_sessions SET lineage_started_at = $1::bigint, issued_at = $1::bigint + 1
           WHERE session_token_hash = $2`,
          [lineageStart, hashSessionToken(session.sessionId)],
        );

        const outcome = await refreshAcrossLockWait(pool, session.sessionId, lineageEndsAt + 1);
        expect(outcome.status).toBe('rejected');
        expect((outcome as PromiseRejectedResult).reason.message).toContain(
          'lifetime is exhausted',
        );

        const rows = await pool.query(`SELECT revoked_at FROM user_sessions`);
        expect(rows.rows).toEqual([{ revoked_at: null }]);
      });
    },
    120000,
  );

  integrationTest(
    'migration hashes legacy raw session tokens in place',
    async () => {
      await withPostgres(async (pool) => {
        await pool.query('CREATE DATABASE auth_legacy');
        const legacyPool = new Pool({
          host: '127.0.0.1',
          port: Number(pool.options.port),
          database: 'auth_legacy',
          user: 'postgres',
          password: 'postgres',
        });
        try {
          for (const file of [
            'schema.sql',
            'schema/002_operator_signer_register.sql',
            'schema/003_operator_signer_two_person_activation.sql',
          ]) {
            await legacyPool.query(fs.readFileSync(path.join(SCHEMA_ROOT, file), 'utf8'));
          }
          const profile = await legacyPool.query<{ id: string }>(
            `INSERT INTO user_profiles (account_id, role) VALUES ('agroasys-user:legacy', 'buyer')
             RETURNING id`,
          );
          const legacyToken = 'a'.repeat(64);
          const issuedAt = nowSeconds();
          await legacyPool.query(
            `INSERT INTO user_sessions (session_id, user_id, role, issued_at, expires_at)
             VALUES ($1, $2, 'buyer', $3, $4)`,
            [legacyToken, profile.rows[0].id, issuedAt, issuedAt + 3600],
          );

          await legacyPool.query(
            fs.readFileSync(
              path.join(SCHEMA_ROOT, 'schema/004_session_token_hash_lineage.sql'),
              'utf8',
            ),
          );

          const migrated = await legacyPool.query(
            `SELECT session_token_hash, lineage_started_at FROM user_sessions`,
          );
          expect(migrated.rows[0].session_token_hash).toBe(hashSessionToken(legacyToken));
          expect(Number(migrated.rows[0].lineage_started_at)).toBe(issuedAt);
          await expect(createService(legacyPool).resolve(legacyToken)).resolves.not.toBeNull();
        } finally {
          await legacyPool.end();
        }
      });
    },
    120000,
  );
});
