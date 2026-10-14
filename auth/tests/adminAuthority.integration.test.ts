/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import {
  ADMIN_CONTROL_APPROVER,
  dockerAvailable,
  EXCHANGE_KEYS,
  grantAdminAuthority,
  postAdminControl,
  signedHeaders,
  startAdminApp,
  TEST_ENVIRONMENT,
  withPostgres,
} from './helpers/adminControlsIntegrationHarness';

const PROPOSE_PATH = '/api/auth/v1/admin/authority-changes/propose';
const APPROVE_PATH = '/api/auth/v1/admin/authority-changes/approve';
const CANCEL_PATH = '/api/auth/v1/admin/authority-changes/cancel';
const EXCHANGE_PATH = '/api/auth/v1/session/exchange/agroasys';

type App = Awaited<ReturnType<typeof startAdminApp>>;

function inDays(days: number): string {
  return new Date(Date.now() + days * 86400 * 1000).toISOString();
}

function proposeGrant(app: App, accountId: string, overrides: Record<string, unknown> = {}) {
  return postAdminControl(app.baseUrl, PROPOSE_PATH, {
    accountId,
    change: 'grant',
    environment: TEST_ENVIRONMENT,
    expiresAt: inDays(7),
    approvalTicket: 'SEC-3000',
    reason: 'Administrator grant under two-person control',
    ...overrides,
  });
}

async function storedRole(pool: Pool, accountId: string): Promise<string | undefined> {
  const result = await pool.query<{ role: string }>(
    `SELECT role FROM user_profiles WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0]?.role;
}

/** Inserts an applied grant directly, as a restored or historical row would exist. */
async function insertAppliedGrant(
  pool: Pool,
  accountId: string,
  environment: string,
  expiresAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO admin_authority_changes (
       account_id, change, environment, grant_expires_at, resulting_role, approval_ticket,
       reason, evidence_digest, state, proposed_by, proposed_by_key, applied_by,
       applied_by_key, applied_at
     ) VALUES ($1, 'grant', $2, $3, 'admin', 'SEC-3999', 'historical grant row', $4,
       'applied', 'human:proposer', 'key-a', 'human:approver', 'key-b', clock_timestamp())`,
    [accountId, environment, expiresAt, 'f'.repeat(64)],
  );
}

describe('two-person admin authority integration', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'a grant applies only when a different human approves its exact digest',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const accountId = 'agroasys-user:ops-two-person';
          const proposed = await proposeGrant(app, accountId);
          expect(proposed.status).toBe(201);
          const change = proposed.json.data!;
          expect(change).toMatchObject({ state: 'pending', change: 'grant' });

          const selfApproval = await postAdminControl(app.baseUrl, APPROVE_PATH, {
            changeId: change.changeId,
            evidenceDigest: change.evidenceDigest,
            reason: 'Proposer attempts to approve their own grant',
          });
          expect(selfApproval.status).toBe(403);

          const wrongDigest = await postAdminControl(
            app.baseUrl,
            APPROVE_PATH,
            {
              changeId: change.changeId,
              evidenceDigest: 'a'.repeat(64),
              reason: 'Approver presents a different digest',
            },
            ADMIN_CONTROL_APPROVER,
          );
          expect(wrongDigest.status).toBe(400);
          expect(await storedRole(pool, accountId)).toBeUndefined();

          const conflicting = await proposeGrant(app, accountId, { approvalTicket: 'SEC-3001' });
          expect(conflicting.status).toBe(409);

          const approved = await postAdminControl(
            app.baseUrl,
            APPROVE_PATH,
            {
              changeId: change.changeId,
              evidenceDigest: change.evidenceDigest,
              reason: 'Second human approves the grant',
            },
            ADMIN_CONTROL_APPROVER,
          );
          expect(approved.status).toBe(200);
          expect(approved.json.data).toMatchObject({
            state: 'applied',
            proposedBy: 'human:agroasys-user:ops-admin-control-test',
            proposedByKey: 'ops-admin-control-test',
            appliedBy: `human:${ADMIN_CONTROL_APPROVER.humanPrincipalId}`,
            appliedByKey: ADMIN_CONTROL_APPROVER.id,
          });
          expect(await storedRole(pool, accountId)).toBe('admin');

          const audit = await pool.query(
            `SELECT metadata FROM auth_admin_audit_events
             WHERE action = 'admin_authority_change_applied' AND account_id = $1`,
            [accountId],
          );
          expect(audit.rows[0].metadata).toMatchObject({
            proposedByKey: 'ops-admin-control-test',
            appliedByKey: ADMIN_CONTROL_APPROVER.id,
            before: { profileExists: false, adminGrantActive: false },
            after: { baseRole: 'admin', adminGrantActive: true },
          });

          // Applied changes are immutable evidence.
          await expect(
            pool.query(
              `UPDATE admin_authority_changes SET grant_expires_at = NOW() + INTERVAL '1 year'
               WHERE id = $1`,
              [change.changeId],
            ),
          ).rejects.toThrow('immutable');
          await expect(
            pool.query(`DELETE FROM admin_authority_changes WHERE id = $1`, [change.changeId]),
          ).rejects.toThrow('cannot be deleted');
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );

  integrationTest(
    'proposals are bound to this environment and a bounded lifetime, and can be cancelled',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const accountId = 'agroasys-user:ops-bounds';
          const otherEnvironment = await proposeGrant(app, accountId, {
            environment: 'production',
          });
          expect(otherEnvironment.status).toBe(403);
          for (const expiresAt of [inDays(0.01), inDays(31), 'not-a-date']) {
            expect((await proposeGrant(app, accountId, { expiresAt })).status).toBe(400);
          }

          const proposed = await proposeGrant(app, accountId);
          expect(proposed.status).toBe(201);
          const cancelled = await postAdminControl(
            app.baseUrl,
            CANCEL_PATH,
            { changeId: proposed.json.data!.changeId, reason: 'Withdrawn before approval' },
            ADMIN_CONTROL_APPROVER,
          );
          expect(cancelled.status).toBe(200);
          expect(cancelled.json.data).toMatchObject({ state: 'cancelled' });
          const lateApproval = await postAdminControl(
            app.baseUrl,
            APPROVE_PATH,
            {
              changeId: proposed.json.data!.changeId,
              evidenceDigest: proposed.json.data!.evidenceDigest,
              reason: 'Approval after cancellation',
            },
            ADMIN_CONTROL_APPROVER,
          );
          expect(lateApproval.status).toBe(409);
          expect(await storedRole(pool, accountId)).toBeUndefined();
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );

  integrationTest(
    'an expired or other-environment grant confers no administrator authority',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const { operator } = EXCHANGE_KEYS;
          const exchangeAdmin = async (accountId: string) => {
            const body = JSON.stringify({ accountId, role: 'admin' });
            const response = await fetch(`${app.baseUrl}${EXCHANGE_PATH}`, {
              method: 'POST',
              headers: signedHeaders({
                method: 'POST',
                path: EXCHANGE_PATH,
                body,
                nonce: `authority-exchange-${accountId}-${Date.now()}-${Math.random()}`,
                apiKey: operator,
              }),
              body,
            });
            const json = (await response.json()) as { data?: { sessionId: string } };
            return { status: response.status, sessionId: json.data?.sessionId };
          };

          // A grant that has lapsed: the session it backed dies, and exchange refuses.
          const lapsing = 'agroasys-user:ops-lapsing';
          await grantAdminAuthority(app.baseUrl, lapsing);
          const issued = await exchangeAdmin(lapsing);
          expect(issued.status).toBe(201);
          await expect(app.sessionService.resolve(issued.sessionId!)).resolves.toMatchObject({
            role: 'admin',
          });
          await insertAppliedGrant(pool, lapsing, TEST_ENVIRONMENT, inDays(-1));
          await expect(app.sessionService.resolve(issued.sessionId!)).resolves.toBeNull();
          expect((await exchangeAdmin(lapsing)).status).toBe(403);

          // A grant applied in another environment's records confers nothing here.
          const foreign = 'agroasys-user:ops-foreign';
          await pool.query(`INSERT INTO user_profiles (account_id, role) VALUES ($1, 'admin')`, [
            foreign,
          ]);
          await insertAppliedGrant(pool, foreign, 'production', inDays(7));
          expect((await exchangeAdmin(foreign)).status).toBe(403);
          await insertAppliedGrant(pool, foreign, TEST_ENVIRONMENT, inDays(7));
          expect((await exchangeAdmin(foreign)).status).toBe(201);
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );
});
