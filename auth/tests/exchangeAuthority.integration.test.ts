/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { hashSessionToken } from '../src/core/sessionStore';
import {
  dockerAvailable,
  EXCHANGE_KEYS,
  grantAdminAuthority,
  revokeAdminAuthority,
  signedHeaders,
  startAdminApp,
  withPostgres,
} from './helpers/adminControlsIntegrationHarness';

const EXCHANGE_PATH = '/api/auth/v1/session/exchange/agroasys';

type App = Awaited<ReturnType<typeof startAdminApp>>;
type ExchangeKey = (typeof EXCHANGE_KEYS)[keyof typeof EXCHANGE_KEYS];

let nonce = 0;

async function post(
  app: App,
  path: string,
  payload: Record<string, unknown>,
  apiKey?: ExchangeKey,
): Promise<{ status: number; json: { data?: { sessionId: string }; message?: string } }> {
  const body = JSON.stringify(payload);
  nonce += 1;
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: signedHeaders({
      method: 'POST',
      path,
      body,
      nonce: `exchange-authority-${nonce}`,
      apiKey,
    }),
    body,
  });
  return { status: response.status, json: await response.json() };
}

const exchange = (
  app: App,
  apiKey: ExchangeKey,
  accountId: string,
  role: string,
  extra: Record<string, unknown> = {},
) => post(app, EXCHANGE_PATH, { accountId, role, ...extra }, apiKey);

async function profileState(pool: Pool, accountId: string) {
  const result = await pool.query<{ role: string; org_id: string | null; sessions: number }>(
    `SELECT role, org_id,
            (SELECT COUNT(*)::int FROM user_sessions WHERE user_id = user_profiles.id) AS sessions
     FROM user_profiles WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0];
}

async function storedRole(pool: Pool, accountId: string): Promise<string | undefined> {
  const result = await pool.query<{ role: string }>(
    `SELECT role FROM user_profiles WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0]?.role;
}

describe('trusted exchange authority integration', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'exchange never creates or changes administrator authority',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const { member, operator } = EXCHANGE_KEYS;

          // A member key cannot request admin, and no key can request oracle.
          const memberAdmin = await exchange(app, member, 'agroasys-user:ceiling', 'admin');
          expect(memberAdmin.status).toBe(403);
          expect(memberAdmin.json.message).toContain('may not issue the admin role');
          expect((await exchange(app, operator, 'agroasys-user:ceiling', 'oracle')).status).toBe(
            403,
          );
          expect(await storedRole(pool, 'agroasys-user:ceiling')).toBeUndefined();

          // An operator key cannot mint admin for an unprovisioned account, nor
          // promote an existing member.
          const unprovisioned = await exchange(app, operator, 'agroasys-user:ops-1', 'admin');
          expect(unprovisioned.status).toBe(403);
          expect(unprovisioned.json.message).toContain('admin control plane');
          expect(await storedRole(pool, 'agroasys-user:ops-1')).toBeUndefined();

          expect((await exchange(app, member, 'agroasys-user:member-1', 'buyer')).status).toBe(201);
          expect((await exchange(app, operator, 'agroasys-user:member-1', 'admin')).status).toBe(
            403,
          );
          expect(await storedRole(pool, 'agroasys-user:member-1')).toBe('buyer');

          // Once granted through the two-person control plane, the operator key
          // obtains an admin session without rewriting the stored role.
          await grantAdminAuthority(app.baseUrl, 'agroasys-user:ops-1');
          const adminExchange = await exchange(app, operator, 'agroasys-user:ops-1', 'admin');
          expect(adminExchange.status).toBe(201);
          const adminSessionId = adminExchange.json.data!.sessionId;
          await expect(app.sessionService.resolve(adminSessionId)).resolves.toMatchObject({
            role: 'admin',
          });

          // A member key cannot demote the provisioned admin through exchange.
          const demotion = await exchange(app, member, 'agroasys-user:ops-1', 'buyer');
          expect(demotion.status).toBe(403);
          expect(demotion.json.message).toContain('cannot be changed through session exchange');
          expect(await storedRole(pool, 'agroasys-user:ops-1')).toBe('admin');

          // Two-person revocation invalidates the admin session.
          await revokeAdminAuthority(app.baseUrl, 'agroasys-user:ops-1');
          await expect(app.sessionService.resolve(adminSessionId)).resolves.toBeNull();
          expect((await exchange(app, operator, 'agroasys-user:ops-1', 'admin')).status).toBe(403);
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );

  integrationTest(
    'an admin row without an active grant is refused until granted',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const { operator } = EXCHANGE_KEYS;
          const accountId = 'agroasys-user:legacy-admin';
          // The state the previous exchange left: an admin row and session with
          // no control-plane audit event.
          const legacy = await pool.query<{ id: string }>(
            `INSERT INTO user_profiles (account_id, role) VALUES ($1, 'admin') RETURNING id`,
            [accountId],
          );
          const now = Math.floor(Date.now() / 1000);
          await pool.query(
            `INSERT INTO user_sessions (
               session_token_hash, user_id, role, issued_at, expires_at, lineage_started_at
             ) VALUES ($1, $2, 'admin', $3::bigint, $3::bigint + 3600, $3::bigint)`,
            [hashSessionToken('legacy-admin-session'), legacy.rows[0].id, now],
          );

          await expect(app.sessionService.resolve('legacy-admin-session')).resolves.toBeNull();
          const revoked = await pool.query(
            `SELECT revoked_at FROM user_sessions WHERE session_token_hash = $1`,
            [hashSessionToken('legacy-admin-session')],
          );
          expect(revoked.rows[0].revoked_at).not.toBeNull();

          const refused = await exchange(app, operator, accountId, 'admin');
          expect(refused.status).toBe(403);
          expect(refused.json.message).toContain('admin control plane');
          expect(await profileState(pool, accountId)).toEqual({
            role: 'admin',
            org_id: null,
            sessions: 1,
          });

          await grantAdminAuthority(app.baseUrl, accountId);
          const admitted = await exchange(app, operator, accountId, 'admin');
          expect(admitted.status).toBe(201);
          await expect(
            app.sessionService.resolve(admitted.json.data!.sessionId),
          ).resolves.toMatchObject({ role: 'admin' });
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );

  integrationTest(
    'an organization-bound key cannot reach another organization',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const { pinned } = EXCHANGE_KEYS;
          for (const [accountId, orgId] of [
            ['agroasys-user:org-b-admin', 'org-b'],
            ['agroasys-user:org-a-admin', 'org-a'],
          ]) {
            await grantAdminAuthority(app.baseUrl, accountId, { orgId });
          }

          for (const extra of [{}, { orgId: 'org-b' }]) {
            const refused = await exchange(
              app,
              pinned,
              'agroasys-user:org-b-admin',
              'admin',
              extra,
            );
            expect(refused.status).toBe(403);
            expect(refused.json.message).toContain('not authorized for this organization');
          }
          expect(await profileState(pool, 'agroasys-user:org-b-admin')).toEqual({
            role: 'admin',
            org_id: 'org-b',
            sessions: 0,
          });

          expect((await exchange(app, pinned, 'agroasys-user:org-a-admin', 'admin')).status).toBe(
            201,
          );

          // A legacy wallet-only profile in another organization cannot be
          // relinked or merged through the bound key.
          const wallet = '0x00000000000000000000000000000000000000dd';
          await pool.query(
            `INSERT INTO user_profiles (account_id, wallet_address, role, org_id)
             VALUES (gen_random_uuid()::text, $1, 'buyer', 'org-b')`,
            [wallet],
          );
          const relink = await exchange(app, pinned, 'agroasys-user:wallet-owner', 'buyer', {
            walletAddress: wallet,
          });
          expect(relink.status).toBe(403);
          expect(await profileState(pool, 'agroasys-user:wallet-owner')).toBeUndefined();
          const legacy = await pool.query(
            `SELECT org_id FROM user_profiles WHERE wallet_address = $1`,
            [wallet],
          );
          expect(legacy.rows).toEqual([{ org_id: 'org-b' }]);
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );
});
