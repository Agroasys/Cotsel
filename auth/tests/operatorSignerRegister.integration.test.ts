/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { createAdminService } from '../src/core/adminService';
import { createPostgresOperatorSignerStore } from '../src/core/operatorSignerStore';
import { createPostgresProfileStore } from '../src/core/profileStore';
import { findSessionById } from '../src/database/queries/sessions';

const POSTGRES_IMAGE = process.env.AUTH_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
let dockerAvailable = true;

try {
  execFileSync('docker', ['version'], { stdio: ['ignore', 'ignore', 'ignore'] });
} catch {
  dockerAvailable = false;
}

function docker(args: string[], options: Parameters<typeof execFileSync>[2] = {}): string {
  return String(
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }),
  ).trim();
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker(['exec', containerName, 'pg_isready', '-U', 'postgres']);
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function waitForPostgresConnection(port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = new Pool({
      host: '127.0.0.1',
      port,
      database: 'auth_test',
      user: 'postgres',
      password: 'postgres',
      connectionTimeoutMillis: 1_000,
      max: 1,
    });
    try {
      await probe.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await probe.end().catch(() => undefined);
    }
  }
}

async function withPostgres(
  fn: (pool: Pool) => Promise<void>,
  beforeApprovalMigration?: (pool: Pool) => Promise<void>,
): Promise<void> {
  const containerName = `cotsel-auth-signer-test-${process.pid}-${Date.now()}`;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=auth_test',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);

  try {
    await waitForPostgres(containerName);
    const port = Number.parseInt(docker(['port', containerName, '5432/tcp']).split(':').pop()!, 10);
    await waitForPostgresConnection(port);
    const pool = new Pool({
      host: '127.0.0.1',
      port,
      database: 'auth_test',
      user: 'postgres',
      password: 'postgres',
    });
    try {
      await pool.query("SET app.service_name = 'auth'");
      for (const file of [
        '../src/database/schema.sql',
        '../src/database/schema/002_operator_signer_register.sql',
      ]) {
        await pool.query(fs.readFileSync(path.resolve(__dirname, file), 'utf8'));
      }
      await beforeApprovalMigration?.(pool);
      await pool.query(
        fs.readFileSync(
          path.resolve(
            __dirname,
            '../src/database/schema/003_operator_signer_two_person_activation.sql',
          ),
          'utf8',
        ),
      );
      await fn(pool);
    } finally {
      await pool.end();
    }
  } finally {
    try {
      docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // Best-effort cleanup of the disposable database.
    }
  }
}

describe('operator signer register persistence', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'revokes legacy free-form approvals while preserving their historical claim',
    async () => {
      await withPostgres(
        async (pool) => {
          const result = await pool.query(
            `SELECT id::text, state, active, created_by, evidence_digest,
                    approved_by_principal, legacy_approval_claim
             FROM operator_signer_bindings WHERE account_id = $1`,
            ['acct-legacy-admin'],
          );
          expect(result.rows[0]).toMatchObject({
            state: 'revoked',
            active: false,
            created_by: 'service_auth:legacy-proposer',
            approved_by_principal: null,
            legacy_approval_claim: {
              approvingAuthority: 'free-form reviewer',
              migratedAs: 'canonical_human_reproposal_required',
            },
          });
          const store = createPostgresOperatorSignerStore(pool);
          await expect(
            store.approve({
              bindingId: result.rows[0].id,
              evidenceDigest: result.rows[0].evidence_digest,
              actor: {
                type: 'service_auth',
                id: 'legacy-proposer-key',
                humanPrincipalId: 'agroasys-user:legacy-proposer',
              },
              reason: 'Legacy records require a new human-attributed proposal.',
            }),
          ).rejects.toThrow('not pending');
        },
        async (pool) => {
          await pool.query(`INSERT INTO user_profiles (account_id, role) VALUES ($1, 'admin')`, [
            'acct-legacy-admin',
          ]);
          await pool.query(
            `INSERT INTO operator_signer_bindings (
               account_id, wallet_address, action_class, environment, custodian_name,
               approving_authority, approved_at, approval_ticket, active, created_by
             ) VALUES ($1, $2, 'governance', 'staging', $3, $4, NOW(), $5, TRUE, $6)`,
            [
              'acct-legacy-admin',
              '0x00000000000000000000000000000000000000aa',
              'Legacy Custodian',
              'free-form reviewer',
              'COTSEL-LEGACY',
              'legacy-proposer',
            ],
          );
        },
      );
    },
    120_000,
  );

  integrationTest(
    'binds sessions to active approval evidence and preserves revoked records',
    async () => {
      await withPostgres(async (pool) => {
        const profile = await pool.query<{ id: string }>(
          `INSERT INTO user_profiles (account_id, wallet_address, email, role)
           VALUES ($1, $2, $3, 'admin') RETURNING id::text AS id`,
          ['acct-admin-1', '0x00000000000000000000000000000000000000aa', 'admin@example.com'],
        );
        await pool.query(
          `INSERT INTO user_sessions
             (session_id, user_id, wallet_address, role, issued_at, expires_at)
           VALUES ($1, $2, $3, 'admin', $4, $5)`,
          [
            'session-admin-1',
            profile.rows[0].id,
            '0x00000000000000000000000000000000000000aa',
            1_700_000_000,
            4_000_000_000,
          ],
        );

        const store = createPostgresOperatorSignerStore(pool);
        const service = createAdminService(createPostgresProfileStore(pool), 3600, store);
        const input = {
          accountId: 'acct-admin-1',
          walletAddress: '0x00000000000000000000000000000000000000AA',
          actionClass: 'governance' as const,
          environment: 'staging',
          custodianName: 'Admin Custodian One',
          approvalTicket: 'COTSEL-641',
          notes: 'Address witnessed on the hardware device.',
          actor: {
            type: 'service_auth' as const,
            id: 'release-security-key-a',
            humanPrincipalId: 'agroasys-user:release-security',
          },
          reason: 'Register witnessed hardware wallet authority.',
        };

        await expect(
          service.proposeSigner({
            ...input,
            actor: {
              ...input.actor,
              humanPrincipalId: 'Operator Display Name',
            },
          }),
        ).rejects.toThrow('authenticated human control principal');

        const created = await service.proposeSigner(input);
        expect(created).toMatchObject({ state: 'pending', active: false });
        await expect(service.proposeSigner(input)).resolves.toEqual(created);
        await expect(findSessionById(pool, 'session-admin-1')).resolves.toEqual(
          expect.objectContaining({ signerAuthorizations: [] }),
        );

        await expect(
          service.approveSigner({
            bindingId: created.bindingId,
            evidenceDigest: created.evidenceDigest,
            actor: input.actor,
            reason: 'Attempt self approval of signer binding.',
          }),
        ).rejects.toThrow('cannot approve');
        await expect(
          service.approveSigner({
            bindingId: created.bindingId,
            evidenceDigest: created.evidenceDigest,
            actor: {
              type: 'service_auth',
              id: 'release-security-key-b',
              humanPrincipalId: 'agroasys-user:release-security',
            },
            reason: 'Attempt self approval using another credential for the same human.',
          }),
        ).rejects.toThrow('cannot approve');
        await expect(
          service.approveSigner({
            bindingId: created.bindingId,
            evidenceDigest: created.evidenceDigest,
            actor: { type: 'system', id: 'background-job' },
            reason: 'Attempt approval without an authenticated control principal.',
          }),
        ).rejects.toThrow('authenticated human control principal');
        await expect(
          service.approveSigner({
            bindingId: created.bindingId,
            evidenceDigest: 'f'.repeat(64),
            actor: {
              type: 'service_auth',
              id: 'security-approver-key',
              humanPrincipalId: 'agroasys-user:security-approver',
            },
            reason: 'Attempt approval with the wrong evidence digest.',
          }),
        ).rejects.toThrow('does not match');
        await expect(
          pool.query(`UPDATE operator_signer_bindings SET wallet_address = $2 WHERE id = $1`, [
            created.bindingId,
            '0x00000000000000000000000000000000000000bb',
          ]),
        ).rejects.toThrow('proposal evidence is immutable');
        await expect(
          pool.query(
            `UPDATE operator_signer_bindings SET action_class = 'treasury_approve' WHERE id = $1`,
            [created.bindingId],
          ),
        ).rejects.toThrow('proposal evidence is immutable');
        await expect(
          pool.query(
            `UPDATE operator_signer_bindings
             SET state = 'active', active = TRUE,
                 approved_by_principal = 'human:agroasys-user:malformed-approver',
                 activated_at = NOW()
             WHERE id = $1`,
            [created.bindingId],
          ),
        ).rejects.toThrow('operator_signer_binding_lifecycle_complete');

        const activated = await service.approveSigner({
          bindingId: created.bindingId,
          evidenceDigest: created.evidenceDigest,
          actor: {
            type: 'service_auth',
            id: 'security-approver-key',
            humanPrincipalId: 'agroasys-user:security-approver',
          },
          reason: 'Approve independently witnessed signer custody.',
        });
        expect(activated).toMatchObject({
          state: 'active',
          active: true,
          approvedByPrincipal: 'human:agroasys-user:security-approver',
        });
        await expect(
          service.approveSigner({
            bindingId: created.bindingId,
            evidenceDigest: created.evidenceDigest,
            actor: {
              type: 'service_auth',
              id: 'another-approver-key',
              humanPrincipalId: 'agroasys-user:another-approver',
            },
            reason: 'Attempt replay of signer approval.',
          }),
        ).rejects.toThrow('not pending');
        const session = await findSessionById(pool, 'session-admin-1');
        expect(session?.signerAuthorizations).toEqual([
          expect.objectContaining({
            bindingId: created.bindingId,
            walletAddress: input.walletAddress.toLowerCase(),
            actionClass: 'governance',
            environment: 'staging',
            approvedBy: 'human:agroasys-user:security-approver',
            ticketRef: 'COTSEL-641',
          }),
        ]);

        await expect(
          pool.query(
            `UPDATE operator_signer_bindings SET approval_ticket = 'ATTACK-1' WHERE id = $1`,
            [created.bindingId],
          ),
        ).rejects.toThrow('proposal evidence is immutable');

        await expect(service.proposeSigner({ ...input, environment: '*' })).rejects.toThrow(
          'wildcard',
        );
        const revoked = await service.revokeSigner({
          bindingId: created.bindingId,
          actor: input.actor,
          reason: 'Revoke the signer after custody rotation.',
        });
        expect(revoked).toMatchObject({
          active: false,
          revokedBy: 'human:agroasys-user:release-security',
        });
        await expect(
          service.approveSigner({
            bindingId: created.bindingId,
            evidenceDigest: created.evidenceDigest,
            actor: {
              type: 'service_auth',
              id: 'security-approver-key',
              humanPrincipalId: 'agroasys-user:security-approver',
            },
            reason: 'Attempt activation after signer revocation.',
          }),
        ).rejects.toThrow('not pending');
        await expect(findSessionById(pool, 'session-admin-1')).resolves.toEqual(
          expect.objectContaining({ signerAuthorizations: [] }),
        );
        await expect(
          pool.query(`UPDATE operator_signer_bindings SET notes = 'changed' WHERE id = $1`, [
            created.bindingId,
          ]),
        ).rejects.toThrow('revoked operator signer bindings are immutable');

        const replacement = await service.proposeSigner({
          ...input,
          approvalTicket: 'COTSEL-641-ROTATION',
          reason: 'Register replacement authority after custody rotation.',
        });
        await service.approveSigner({
          bindingId: replacement.bindingId,
          evidenceDigest: replacement.evidenceDigest,
          actor: {
            type: 'service_auth',
            id: 'security-approver-key',
            humanPrincipalId: 'agroasys-user:security-approver',
          },
          reason: 'Approve replacement signer custody independently.',
        });
        await pool.query(`UPDATE user_profiles SET role = 'buyer' WHERE account_id = $1`, [
          input.accountId,
        ]);
        const afterDowngrade = await store.list({ accountId: input.accountId, active: false });
        expect(afterDowngrade).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              bindingId: replacement.bindingId,
              active: false,
              revokedBy: 'auth:profile-authority-trigger',
              revokedReason: 'profile_authority_removed',
            }),
          ]),
        );
        await expect(findSessionById(pool, 'session-admin-1')).resolves.toEqual(
          expect.objectContaining({ role: 'buyer', signerAuthorizations: [] }),
        );

        const audit = await pool.query<{
          action: string;
          actor_id: string;
          metadata: { authenticatedHumanPrincipalId: string };
        }>(
          `SELECT action, actor_id, metadata
           FROM auth_admin_audit_events ORDER BY created_at, id`,
        );
        expect(audit.rows.map((row) => row.action)).toEqual([
          'signer_binding_proposed',
          'signer_binding_activated',
          'signer_binding_revoked',
          'signer_binding_proposed',
          'signer_binding_activated',
        ]);
        expect(audit.rows[0]).toMatchObject({
          actor_id: 'release-security-key-a',
          metadata: {
            authenticatedHumanPrincipalId: 'agroasys-user:release-security',
          },
        });
        expect(audit.rows[1]).toMatchObject({
          actor_id: 'security-approver-key',
          metadata: {
            authenticatedHumanPrincipalId: 'agroasys-user:security-approver',
          },
        });
      });
    },
    120_000,
  );
});
