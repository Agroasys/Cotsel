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

async function withPostgres(fn: (pool: Pool) => Promise<void>): Promise<void> {
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
          approvingAuthority: 'Security Owner',
          approvedAt: '2026-09-11T10:00:00.000Z',
          approvalTicket: 'COTSEL-641',
          notes: 'Address witnessed on the hardware device.',
          actor: { type: 'service_auth' as const, id: 'release-security' },
          reason: 'Register witnessed hardware wallet authority.',
        };

        const created = await service.provisionSigner(input);
        await expect(service.provisionSigner(input)).resolves.toEqual(created);
        const session = await findSessionById(pool, 'session-admin-1');
        expect(session?.signerAuthorizations).toEqual([
          expect.objectContaining({
            bindingId: created.bindingId,
            walletAddress: input.walletAddress.toLowerCase(),
            actionClass: 'governance',
            environment: 'staging',
            approvedBy: 'Security Owner',
            ticketRef: 'COTSEL-641',
          }),
        ]);

        await expect(
          pool.query(
            `UPDATE operator_signer_bindings SET approval_ticket = 'ATTACK-1' WHERE id = $1`,
            [created.bindingId],
          ),
        ).rejects.toThrow('approval evidence is immutable');

        await expect(service.provisionSigner({ ...input, environment: '*' })).rejects.toThrow(
          'wildcard',
        );
        const revoked = await service.revokeSigner({
          bindingId: created.bindingId,
          actor: input.actor,
          reason: 'Revoke the signer after custody rotation.',
        });
        expect(revoked).toMatchObject({ active: false, revokedBy: 'release-security' });
        await expect(findSessionById(pool, 'session-admin-1')).resolves.toEqual(
          expect.objectContaining({ signerAuthorizations: [] }),
        );
        await expect(
          pool.query(`UPDATE operator_signer_bindings SET notes = 'changed' WHERE id = $1`, [
            created.bindingId,
          ]),
        ).rejects.toThrow('revoked operator signer bindings are immutable');

        const replacement = await service.provisionSigner({
          ...input,
          approvalTicket: 'COTSEL-641-ROTATION',
          reason: 'Register replacement authority after custody rotation.',
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

        const audit = await pool.query<{ action: string }>(
          `SELECT action FROM auth_admin_audit_events ORDER BY created_at, id`,
        );
        expect(audit.rows.map((row) => row.action)).toEqual([
          'signer_binding_provisioned',
          'signer_binding_revoked',
          'signer_binding_provisioned',
        ]);
      });
    },
    120_000,
  );
});
