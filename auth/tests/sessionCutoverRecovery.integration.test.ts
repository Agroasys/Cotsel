/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import { assertMigrationHistory, runVersionedMigrations } from '@agroasys/shared-db/migrate';
import { createPostgresProfileStore } from '../src/core/profileStore';
import { createPostgresSessionStore } from '../src/core/sessionStore';
import { createSessionService } from '../src/core/sessionService';
import { dockerAvailable, withPostgres } from './helpers/adminControlsIntegrationHarness';

const DATABASE_ROOT = path.resolve(__dirname, '../src/database');
const REVERT_SQL = fs.readFileSync(
  path.resolve(__dirname, '../recovery/004_session_token_hash_lineage.revert.sql'),
  'utf8',
);
const LIFETIME = { ttlSeconds: 3600, absoluteLifetimeSeconds: 86400 };
const LEGACY_TOKEN = 'b'.repeat(64);
const RUNTIME_ROLE = 'cotsel_auth_app';

/**
 * Writes the manifest the previous auth image ships: every migration up to,
 * but excluding, 202610100004.
 */
function writePreviousManifest(directory: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATABASE_ROOT, 'migrations.json'), 'utf8'));
  const previous = manifest.migrations.filter(
    (migration: { version: string }) => migration.version < '202610100004',
  );
  fs.mkdirSync(path.join(directory, 'schema'));
  for (const migration of previous) {
    fs.copyFileSync(path.join(DATABASE_ROOT, migration.file), path.join(directory, migration.file));
  }
  const manifestPath = path.join(directory, 'migrations.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ migrations: previous }));
  return manifestPath;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The statements the previous image issues against `user_sessions`. */
const previousImage = {
  insert: (pool: Pool, token: string, userId: string) =>
    pool.query(
      `INSERT INTO user_sessions (session_id, user_id, wallet_address, role, issued_at, expires_at)
       VALUES ($1, $2, NULL, 'buyer', $3, $4)`,
      [token, userId, nowSeconds(), nowSeconds() + 3600],
    ),
  lookup: (pool: Pool, token: string) =>
    pool.query(`SELECT session_id FROM user_sessions WHERE session_id = $1`, [token]),
  revoke: (pool: Pool, token: string) =>
    pool.query(`UPDATE user_sessions SET revoked_at = $1 WHERE session_id = $2`, [
      nowSeconds(),
      token,
    ]),
};

describe('auth session cutover and recovery', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'previous image fails after 202610100004 and runs again after the reviewed revert',
    async () => {
      await withPostgres(async (pool) => {
        await pool.query('CREATE DATABASE auth_cutover');
        await pool.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
        const db = new Pool({
          host: '127.0.0.1',
          port: Number(pool.options.port),
          database: 'auth_cutover',
          user: 'postgres',
          password: 'postgres',
          options: `-c app.service_name=auth -c app.runtime_db_user=${RUNTIME_ROLE}`,
        });
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cutover-'));
        const previousManifest = writePreviousManifest(scratch);
        const candidateManifest = path.join(DATABASE_ROOT, 'migrations.json');
        const migrate = (manifestPath: string) =>
          runVersionedMigrations({
            pool: db,
            serviceName: 'auth',
            manifestPath,
            runtimeDbUser: RUNTIME_ROLE,
          });
        const startupCheck = (manifestPath: string) =>
          assertMigrationHistory({ pool: db, serviceName: 'auth', manifestPath });

        try {
          await migrate(previousManifest);
          await startupCheck(previousManifest);
          const profile = await db.query<{ id: string }>(
            `INSERT INTO user_profiles (account_id, role) VALUES ('agroasys-user:cutover', 'buyer')
             RETURNING id`,
          );
          const userId = profile.rows[0].id;
          await previousImage.insert(db, LEGACY_TOKEN, userId);

          // The revert refuses to run unless 202610100004 is the ledger head.
          await expect(db.query(REVERT_SQL)).rejects.toThrow('expected 202610100004');

          await migrate(candidateManifest);

          // Previous image: startup check and session SQL both fail.
          await expect(startupCheck(previousManifest)).rejects.toThrow(
            'Applied migration 202610100004 is missing from the manifest',
          );
          await expect(previousImage.lookup(db, LEGACY_TOKEN)).rejects.toMatchObject({
            code: '42703',
          });

          // Candidate image: starts and keeps the pre-migration session valid.
          await startupCheck(candidateManifest);
          const candidate = createSessionService(
            createPostgresSessionStore(db),
            createPostgresProfileStore(db),
            LIFETIME,
          );
          await expect(candidate.resolve(LEGACY_TOKEN)).resolves.not.toBeNull();

          const sessionGrants = () =>
            db.query(
              `SELECT has_table_privilege($1, 'user_sessions', 'SELECT, INSERT, UPDATE, DELETE')
                 AS granted`,
              [RUNTIME_ROLE],
            );
          expect((await sessionGrants()).rows[0].granted).toBe(true);

          await db.query(REVERT_SQL);

          // Previous image: startup check (ledger and schema fingerprint) passes,
          // every session is gone, and its session SQL works again.
          await startupCheck(previousManifest);
          const sessions = await db.query(`SELECT COUNT(*)::int AS count FROM user_sessions`);
          expect(sessions.rows[0].count).toBe(0);
          expect((await sessionGrants()).rows[0].granted).toBe(true);
          const profiles = await db.query(`SELECT COUNT(*)::int AS count FROM user_profiles`);
          expect(profiles.rows[0].count).toBe(1);
          await previousImage.insert(db, LEGACY_TOKEN, userId);
          await expect(previousImage.lookup(db, LEGACY_TOKEN)).resolves.toMatchObject({
            rowCount: 1,
          });
          await previousImage.revoke(db, LEGACY_TOKEN);

          // Rolling forward again reapplies 202610100004 cleanly.
          await migrate(candidateManifest);
          await startupCheck(candidateManifest);
        } finally {
          await db.end();
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      });
    },
    120000,
  );
});
