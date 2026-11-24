/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cotsel#946 at the real boundary: a correctly signed admin-control grant is
 * still refused when the operator's step-up is stale or missing.
 */
import { freshOperatorAuthentication } from './helpers/operatorAuthentication';
import {
  dockerAvailable,
  signedHeaders,
  startAdminApp,
  withPostgres,
} from './helpers/adminControlsIntegrationHarness';

const GRANT_PATH = '/api/auth/v1/admin/break-glass/grant';

describe('break-glass step-up at the signed grant route (Cotsel#946)', () => {
  const integrationTest = dockerAvailable ? test : test.skip;
  integrationTest(
    'a signed grant without a fresh hardware step-up is refused and grants nothing',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const cases: Array<[string, unknown]> = [
            ['stale', freshOperatorAuthentication(3600)],
            ['missing', undefined],
            ['weak', { ...freshOperatorAuthentication(0), authStrength: 'password' }],
          ];
          for (const [label, operatorAuthentication] of cases) {
            const body = JSON.stringify({
              accountId: 'agroasys-user:bg-step-up',
              baseRole: 'buyer',
              ttlSeconds: 300,
              operatorAuthentication,
              reason: `INC-946 ${label} step-up must not grant break-glass`,
            });
            const response = await fetch(`${app.baseUrl}${GRANT_PATH}`, {
              method: 'POST',
              headers: signedHeaders({
                method: 'POST',
                path: GRANT_PATH,
                body,
                nonce: `nonce-bg-step-up-${label}`,
              }),
              body,
            });
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({ error: 'StepUpRequired' });
          }
          const granted = await pool.query(
            `SELECT count(*)::int AS n FROM user_profiles
             WHERE account_id = 'agroasys-user:bg-step-up' AND break_glass_role IS NOT NULL`,
          );
          expect(granted.rows[0].n).toBe(0);
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  integrationTest(
    "a granted break-glass records the operator's verified step-up in its own audit entry",
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const operatorAuthentication = freshOperatorAuthentication(30);
          const body = JSON.stringify({
            accountId: 'agroasys-user:bg-audited',
            baseRole: 'buyer',
            ttlSeconds: 300,
            operatorAuthentication,
            reason: 'INC-946 a fresh hardware step-up grants and is audited',
          });
          const response = await fetch(`${app.baseUrl}${GRANT_PATH}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: GRANT_PATH,
              body,
              nonce: 'nonce-bg-audited',
            }),
            body,
          });
          expect(response.status).toBe(201);

          const audit = await pool.query(
            `SELECT metadata FROM auth_admin_audit_events
             WHERE account_id = 'agroasys-user:bg-audited' AND action = 'break_glass_granted'`,
          );
          expect(audit.rows).toHaveLength(1);
          expect(audit.rows[0].metadata.stepUp).toEqual({
            authTime: operatorAuthentication.authTime,
            method: 'webauthn',
            strength: 'hardware_webauthn',
            ageSeconds: expect.any(Number),
            maxAgeSeconds: 300,
            acceptedStrengths: ['hardware_webauthn'],
          });
          expect(audit.rows[0].metadata.stepUp.ageSeconds).toBeGreaterThanOrEqual(30);
          expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/signature|bearer|secret/i);
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );
});
