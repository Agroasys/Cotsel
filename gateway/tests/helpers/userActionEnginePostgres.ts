/** SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'crypto';
import path from 'path';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
/**
 * CI points SETTLEMENT_ACTIVITY_DATABASE_URL at its 5432 service; a local run can
 * point it at a disposable container instead. Every process of a test uses this.
 */
export function testPostgresPort(): number {
  const url = process.env.SETTLEMENT_ACTIVITY_DATABASE_URL;
  return (url && Number(new URL(url).port)) || 5432;
}

const SOURCE_DIRECTORY = path.resolve(__dirname, '../../src/database');

/**
 * Writes the gateway manifest truncated at `throughVersion`, without the
 * `withoutVersions` migrations, to a temporary directory with its files and
 * returns the manifest path. The caller removes the directory.
 */
export function writeManifestThrough(
  throughVersion?: string,
  withoutVersions: readonly string[] = [],
): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'gateway-history-'));
  const manifest = JSON.parse(
    readFileSync(path.join(SOURCE_DIRECTORY, 'migrations.json'), 'utf8'),
  ) as {
    migrations: Array<{ version: string; file: string; schema_sha256?: string }>;
  };
  manifest.migrations = manifest.migrations.filter(
    (row) =>
      (!throughVersion || row.version <= throughVersion) && !withoutVersions.includes(row.version),
  );
  // A schema fingerprint is cumulative: after an omitted migration, each pin
  // describes a schema this history never builds. File checksums still apply.
  const firstOmitted = [...withoutVersions].sort()[0];
  if (firstOmitted) {
    for (const row of manifest.migrations) {
      if (row.version > firstOmitted) delete row.schema_sha256;
    }
  }
  for (const row of manifest.migrations) {
    const target = path.join(directory, row.file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(SOURCE_DIRECTORY, row.file), target);
  }
  const manifestPath = path.join(directory, 'migrations.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

export async function createUserActionEnginePostgres(
  throughVersion?: '202610170015' | '202610180016',
  options: { withoutVersions?: readonly string[] } = {},
) {
  const name = `ua_${randomUUID().replace(/-/g, '')}`;
  const connection = {
    host: '127.0.0.1',
    port: testPostgresPort(),
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
  };
  const admin = new Pool(connection);
  let role = false,
    db = false;
  let owner: Pool | undefined, runtime: Pool | undefined;
  let manifestDirectory: string | undefined;
  const close = async () => {
    await runtime?.end();
    await owner?.end();
    try {
      if (db) await admin.query(`DROP DATABASE ${name}`);
    } finally {
      if (role) await admin.query(`DROP ROLE ${name}`);
      await admin.end();
      if (manifestDirectory) rmSync(manifestDirectory, { recursive: true, force: true });
    }
  };
  try {
    await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'local-test-only'`);
    role = true;
    await admin.query(`CREATE DATABASE ${name}`);
    db = true;
    owner = new Pool({
      ...connection,
      database: name,
      max: 4,
      options: `-c app.runtime_db_user=${name}`,
    });
    await owner.query(`SET app.runtime_db_user='${name}'`);
    let manifestPath = path.join(SOURCE_DIRECTORY, 'migrations.json');
    if (throughVersion || options.withoutVersions?.length) {
      manifestPath = writeManifestThrough(throughVersion, options.withoutVersions);
      manifestDirectory = path.dirname(manifestPath);
    }
    const args = {
      pool: owner,
      serviceName: 'gateway',
      manifestPath,
      runtimeDbUser: name,
    };
    await runVersionedMigrations(args);
    // Runner verifies manifest checksums/final schema again on idempotent second invocation.
    await runVersionedMigrations(args);
    runtime = new Pool({
      ...connection,
      database: name,
      user: name,
      password: 'local-test-only',
      options: '-c app.service_name=gateway',
      max: 4,
    });
    return { owner, runtime, name, close };
  } catch (error) {
    await close();
    throw error;
  }
}
