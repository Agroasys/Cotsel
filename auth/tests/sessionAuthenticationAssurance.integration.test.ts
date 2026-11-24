/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cotsel#946: authentication assurance is persisted with the session, returned
 * on lookup, and carried unchanged through refresh.
 */
import { Pool } from 'pg';
import { createPostgresProfileStore } from '../src/core/profileStore';
import { createPostgresSessionStore, hashSessionToken } from '../src/core/sessionStore';
import { createSessionService } from '../src/core/sessionService';
import type { AuthenticationAssurance } from '../src/types';
import { dockerAvailable, withPostgres } from './helpers/adminControlsIntegrationHarness';
import { ANY_ROLE_AUTHORITY } from './helpers/exchangeAuthority';

const LIFETIME = { ttlSeconds: 3600, absoluteLifetimeSeconds: 86400 };
const nowSeconds = () => Math.floor(Date.now() / 1000);

function createService(pool: Pool) {
  return createSessionService(
    createPostgresSessionStore(pool, 'test'),
    createPostgresProfileStore(pool, 'test'),
    LIFETIME,
  );
}

function issue(
  pool: Pool,
  authentication?: AuthenticationAssurance,
  accountId = 'agroasys-user:946',
) {
  return createService(pool).issueTrustedSession(
    { accountId, role: 'buyer', email: 'assurance@example.com', walletAddress: null },
    ANY_ROLE_AUTHORITY,
    undefined,
    authentication,
  );
}

const describeIfDocker = dockerAvailable ? describe : describe.skip;

describeIfDocker('session authentication assurance persistence', () => {
  it('stores the assurance, returns it on lookup and keeps it across refresh', async () => {
    await withPostgres(async (pool) => {
      const assurance: AuthenticationAssurance = {
        authTime: nowSeconds() - 120,
        method: 'webauthn',
        strength: 'hardware_webauthn',
      };
      const service = createService(pool);
      const issued = await issue(pool, assurance);
      const resolved = await service.resolve(issued.sessionId);
      expect(resolved?.authentication).toEqual(assurance);

      const successor = await service.refresh(issued.sessionId);
      const refreshed = await service.resolve(successor.sessionId);
      expect(refreshed?.authentication).toEqual(assurance);
      const rows = await pool.query<{ auth_time: string; issued_at: string }>(
        `SELECT auth_time, issued_at FROM user_sessions WHERE session_token_hash = $1`,
        [hashSessionToken(successor.sessionId)],
      );
      expect(Number(rows.rows[0].auth_time)).toBe(assurance.authTime);
    });
  }, 120_000);

  it('leaves a session without assurance as nulls', async () => {
    await withPostgres(async (pool) => {
      const issued = await issue(pool, undefined, 'agroasys-user:946-none');
      const resolved = await createService(pool).resolve(issued.sessionId);
      expect(resolved?.authentication).toEqual({ authTime: null, method: null, strength: null });
    });
  }, 120_000);

  it('rejects unknown methods, unknown strengths and an authTime after issue in the database', async () => {
    await withPostgres(async (pool) => {
      const issued = await issue(pool, undefined, 'agroasys-user:946-constraints');
      const hash = hashSessionToken(issued.sessionId);
      for (const [column, value] of [
        ['auth_method', 'sms'],
        ['auth_strength', 'strong'],
      ] as const) {
        await expect(
          pool.query(`UPDATE user_sessions SET ${column} = $1 WHERE session_token_hash = $2`, [
            value,
            hash,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      }
      await expect(
        pool.query(
          `UPDATE user_sessions SET auth_time = issued_at + 61 WHERE session_token_hash = $1`,
          [hash],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  }, 120_000);
});
