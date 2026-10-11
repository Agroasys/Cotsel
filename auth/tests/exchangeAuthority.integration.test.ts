/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import {
  dockerAvailable,
  EXCHANGE_KEYS,
  signedHeaders,
  startAdminApp,
  withPostgres,
} from './helpers/adminControlsIntegrationHarness';

const EXCHANGE_PATH = '/api/auth/v1/session/exchange/agroasys';
const PROVISION_PATH = '/api/auth/v1/admin/profiles/provision';

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

const exchange = (app: App, apiKey: ExchangeKey, accountId: string, role: string) =>
  post(app, EXCHANGE_PATH, { accountId, role }, apiKey);

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

          // Once provisioned through the audited control plane, the operator key
          // obtains an admin session without rewriting the stored role.
          const provisioned = await post(app, PROVISION_PATH, {
            accountId: 'agroasys-user:ops-1',
            role: 'admin',
            reason: 'SEC-1100 provision operator before session exchange',
          });
          expect(provisioned.status).toBe(201);
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

          // Demotion through the control plane invalidates the admin session.
          const demoted = await post(app, PROVISION_PATH, {
            accountId: 'agroasys-user:ops-1',
            role: 'buyer',
            reason: 'SEC-1101 remove operator authority',
          });
          expect(demoted.status).toBe(201);
          await expect(app.sessionService.resolve(adminSessionId)).resolves.toBeNull();
          expect((await exchange(app, operator, 'agroasys-user:ops-1', 'admin')).status).toBe(403);
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );
});
