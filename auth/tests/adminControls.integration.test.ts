/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { OPERATOR_CAPABILITIES } from '../src/types';
import {
  dockerAvailable,
  signedHeaders,
  startAdminApp,
  withPostgres,
} from './helpers/adminControlsIntegrationHarness';

describe('admin controls persistence integration', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'admin provisioning, break-glass, audit, replay, and revocation persist correctly',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const provisionPath = '/api/auth/v1/admin/profiles/provision';
          const provisionBody = JSON.stringify({
            accountId: 'agroasys-user:admin-1',
            role: 'admin',
            email: 'admin@example.com',
            orgId: 'ops',
            reason: 'SEC-1000 durable admin provisioning for integration proof',
          });
          const denied = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: {
              ...signedHeaders({
                method: 'POST',
                path: provisionPath,
                body: provisionBody,
                nonce: 'nonce-denied-1',
              }),
              'X-Api-Key': 'not-allowed-for-admin-control',
            },
            body: provisionBody,
          });
          expect(denied.status).toBe(401);

          const first = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: provisionBody,
              nonce: 'nonce-provision-1',
            }),
            body: provisionBody,
          });
          expect(first.status).toBe(201);

          const replay = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: provisionBody,
              nonce: 'nonce-provision-1',
            }),
            body: provisionBody,
          });
          expect(replay.status).toBe(401);

          const provisioned = await pool.query(
            `SELECT role, active FROM user_profiles WHERE account_id = $1`,
            ['agroasys-user:admin-1'],
          );
          expect(provisioned.rows[0]).toMatchObject({ role: 'admin', active: true });

          const session = await app.sessionService.issueTrustedSession({
            accountId: 'agroasys-user:admin-1',
            role: 'admin',
            email: 'admin@example.com',
          });

          const downgradeBody = JSON.stringify({
            accountId: 'agroasys-user:admin-1',
            role: 'buyer',
            reason: 'SEC-1001 durable admin revoked after integration proof',
          });
          const downgrade = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: downgradeBody,
              nonce: 'nonce-downgrade-1',
            }),
            body: downgradeBody,
          });
          expect(downgrade.status).toBe(201);
          await expect(app.sessionService.resolve(session.sessionId)).resolves.toBeNull();

          const durableAdminBody = JSON.stringify({
            accountId: 'agroasys-user:admin-2',
            role: 'admin',
            email: 'admin-2@example.com',
            reason: 'SEC-1003 durable admin provisioning before break-glass rejection proof',
          });
          const durableAdmin = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: durableAdminBody,
              nonce: 'nonce-provision-admin-2',
            }),
            body: durableAdminBody,
          });
          expect(durableAdmin.status).toBe(201);

          const grantPath = '/api/auth/v1/admin/break-glass/grant';
          const reviewPath = '/api/auth/v1/admin/break-glass/review';
          const rejectedAdminGrantBody = JSON.stringify({
            accountId: 'agroasys-user:admin-2',
            baseRole: 'buyer',
            ttlSeconds: 300,
            reason: 'INC-1999 reject break-glass for durable admin integration proof',
          });
          const rejectedAdminGrant = await fetch(`${app.baseUrl}${grantPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: grantPath,
              body: rejectedAdminGrantBody,
              nonce: 'nonce-bg-admin-reject-1',
            }),
            body: rejectedAdminGrantBody,
          });
          expect(rejectedAdminGrant.status).toBe(409);

          const grantBody = JSON.stringify({
            accountId: 'agroasys-user:bg-1',
            baseRole: 'buyer',
            ttlSeconds: 300,
            reason: 'INC-2000 temporary admin integration proof',
          });
          const grant = await fetch(`${app.baseUrl}${grantPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: grantPath,
              body: grantBody,
              nonce: 'nonce-bg-grant-1',
            }),
            body: grantBody,
          });
          expect(grant.status).toBe(201);

          const breakGlassProfile = await pool.query(
            `SELECT role, break_glass_role, break_glass_expires_at
             FROM user_profiles WHERE account_id = $1`,
            ['agroasys-user:bg-1'],
          );
          expect(breakGlassProfile.rows[0].role).toBe('buyer');
          expect(breakGlassProfile.rows[0].break_glass_role).toBe('admin');
          expect(breakGlassProfile.rows[0].break_glass_expires_at).toBeTruthy();

          const activeReviewBody = JSON.stringify({
            accountId: 'agroasys-user:bg-1',
            reason: 'INC-2000 reject review before temporary admin expires',
          });
          const activeReview = await fetch(`${app.baseUrl}${reviewPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: reviewPath,
              body: activeReviewBody,
              nonce: 'nonce-bg-active-review-reject-1',
            }),
            body: activeReviewBody,
          });
          expect(activeReview.status).toBe(409);
          const activeReviewState = await pool.query(
            `SELECT break_glass_role, break_glass_reviewed_at
             FROM user_profiles WHERE account_id = $1`,
            ['agroasys-user:bg-1'],
          );
          expect(activeReviewState.rows[0]).toMatchObject({
            break_glass_role: 'admin',
            break_glass_reviewed_at: null,
          });

          await pool.query(
            `UPDATE user_profiles SET break_glass_expires_at = NULL
             WHERE account_id = $1`,
            ['agroasys-user:bg-1'],
          );
          const incompleteGrantReviewBody = JSON.stringify({
            accountId: 'agroasys-user:bg-1',
            reason: 'INC-2000 reject review without closure evidence',
          });
          const incompleteGrantReview = await fetch(`${app.baseUrl}${reviewPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: reviewPath,
              body: incompleteGrantReviewBody,
              nonce: 'nonce-bg-incomplete-review-reject-1',
            }),
            body: incompleteGrantReviewBody,
          });
          expect(incompleteGrantReview.status).toBe(409);
          const incompleteGrantReviewState = await pool.query(
            `SELECT break_glass_role, break_glass_expires_at, break_glass_reviewed_at
             FROM user_profiles WHERE account_id = $1`,
            ['agroasys-user:bg-1'],
          );
          expect(incompleteGrantReviewState.rows[0]).toMatchObject({
            break_glass_role: 'admin',
            break_glass_expires_at: null,
            break_glass_reviewed_at: null,
          });
          await pool.query(
            `UPDATE user_profiles SET break_glass_expires_at = NOW() + INTERVAL '5 minutes'
             WHERE account_id = $1`,
            ['agroasys-user:bg-1'],
          );

          const existingSupplierBody = JSON.stringify({
            accountId: 'agroasys-user:supplier-bg',
            role: 'supplier',
            reason: 'SEC-1004 durable supplier profile before break-glass base-role proof',
          });
          const existingSupplier = await fetch(`${app.baseUrl}${provisionPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: provisionPath,
              body: existingSupplierBody,
              nonce: 'nonce-provision-supplier-bg',
            }),
            body: existingSupplierBody,
          });
          expect(existingSupplier.status).toBe(201);

          const supplierGrantBody = JSON.stringify({
            accountId: 'agroasys-user:supplier-bg',
            baseRole: 'buyer',
            ttlSeconds: 300,
            reason: 'INC-2001 temporary admin keeps existing durable supplier base role',
          });
          const supplierGrant = await fetch(`${app.baseUrl}${grantPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: grantPath,
              body: supplierGrantBody,
              nonce: 'nonce-bg-supplier-grant-1',
            }),
            body: supplierGrantBody,
          });
          expect(supplierGrant.status).toBe(201);
          const supplierState = await pool.query(
            `SELECT role, break_glass_role
             FROM user_profiles WHERE account_id = $1`,
            ['agroasys-user:supplier-bg'],
          );
          expect(supplierState.rows[0]).toMatchObject({
            role: 'supplier',
            break_glass_role: 'admin',
          });

          const bgSession = await app.sessionService.issueTrustedSession({
            accountId: 'agroasys-user:bg-1',
            role: 'buyer',
            email: 'breakglass@example.com',
          });
          const issuedBreakGlassSession = await pool.query(
            `SELECT role FROM user_sessions WHERE session_id = $1`,
            [bgSession.sessionId],
          );
          expect(issuedBreakGlassSession.rows[0].role).toBe('admin');
          await pool.query(
            `UPDATE user_profiles SET break_glass_expires_at = NOW() - INTERVAL '1 second'
             WHERE account_id = $1`,
            ['agroasys-user:bg-1'],
          );
          await expect(app.sessionService.resolve(bgSession.sessionId)).resolves.toBeNull();

          const reviewBody = JSON.stringify({
            accountId: 'agroasys-user:bg-1',
            reason: 'INC-2000 reviewed expired temporary admin integration proof',
          });
          const review = await fetch(`${app.baseUrl}${reviewPath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: reviewPath,
              body: reviewBody,
              nonce: 'nonce-bg-review-1',
            }),
            body: reviewBody,
          });
          expect(review.status).toBe(200);

          const postExpirySession = await app.sessionService.issueTrustedSession({
            accountId: 'agroasys-user:bg-1',
            role: 'buyer',
            email: 'breakglass@example.com',
          });
          const issuedBaseSession = await pool.query(
            `SELECT role FROM user_sessions WHERE session_id = $1`,
            [postExpirySession.sessionId],
          );
          expect(issuedBaseSession.rows[0].role).toBe('buyer');

          const deactivatePath = '/api/auth/v1/admin/profiles/deactivate';
          const deactivateBody = JSON.stringify({
            accountId: 'agroasys-user:bg-1',
            reason: 'SEC-1002 deactivate temporary admin test account',
          });
          const deactivate = await fetch(`${app.baseUrl}${deactivatePath}`, {
            method: 'POST',
            headers: signedHeaders({
              method: 'POST',
              path: deactivatePath,
              body: deactivateBody,
              nonce: 'nonce-deactivate-1',
            }),
            body: deactivateBody,
          });
          expect(deactivate.status).toBe(200);
          await expect(app.sessionService.resolve(postExpirySession.sessionId)).resolves.toBeNull();

          const audit = await pool.query(
            `SELECT action, previous_role, new_role, reason
             FROM auth_admin_audit_events ORDER BY created_at ASC`,
          );
          expect(audit.rows.map((row) => row.action)).toEqual(
            expect.arrayContaining([
              'profile_provisioned',
              'profile_role_updated',
              'break_glass_granted',
              'break_glass_expired',
              'break_glass_reviewed',
              'profile_deactivated',
            ]),
          );
          expect(audit.rows.every((row) => String(row.reason).length >= 8)).toBe(true);
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );

  integrationTest(
    'a durable admin role confers capabilities but no implicit signer authority',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const session = await app.sessionService.issueTrustedSession({
            accountId: 'agroasys-user:trusted-admin-only',
            role: 'admin',
            email: 'trusted-admin-only@example.com',
            walletAddress: '0x00000000000000000000000000000000000000bb',
          });

          const resolved = await app.sessionService.resolve(session.sessionId);
          expect(resolved?.role).toBe('admin');
          expect([...(resolved?.capabilities ?? [])].sort()).toEqual(
            [...OPERATOR_CAPABILITIES].sort(),
          );
          expect(resolved?.signerAuthorizations).toEqual([]);
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );

  integrationTest(
    'a non-admin session is granted no operator capabilities or signer authority',
    async () => {
      await withPostgres(async (pool) => {
        const app = await startAdminApp(pool);
        try {
          const session = await app.sessionService.issueTrustedSession({
            accountId: 'agroasys-user:buyer-only',
            role: 'buyer',
            email: 'buyer-only@example.com',
            walletAddress: '0x00000000000000000000000000000000000000cc',
          });

          const resolved = await app.sessionService.resolve(session.sessionId);
          expect(resolved?.role).toBe('buyer');
          expect(resolved?.capabilities).toEqual([]);
          expect(resolved?.signerAuthorizations).toEqual([]);
        } finally {
          await app.close();
        }
      });
    },
    120000,
  );
});
