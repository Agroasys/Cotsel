/** SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'crypto';
import path from 'path';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';
export async function createUserActionEnginePostgres() {
  const name = `ua_${randomUUID().replace(/-/g, '')}`;
  const connection = {
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
  };
  const admin = new Pool(connection);
  let role = false,
    db = false;
  let owner: Pool | undefined, runtime: Pool | undefined;
  const close = async () => {
    await runtime?.end();
    await owner?.end();
    try {
      if (db) await admin.query(`DROP DATABASE ${name}`);
    } finally {
      if (role) await admin.query(`DROP ROLE ${name}`);
      await admin.end();
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
    const args = {
      pool: owner,
      serviceName: 'gateway',
      manifestPath: path.resolve(__dirname, '../../src/database/migrations.json'),
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
