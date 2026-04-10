'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const { createServicePool } = require('./index');

const POSTGRES_IMAGE = process.env.SHARED_DB_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
let dockerAvailable = true;

try {
  docker(['version']);
} catch {
  dockerAvailable = false;
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgres(containerName) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker(['exec', containerName, 'pg_isready', '-U', 'postgres']);
      return;
    } catch (error) {
      if (attempt === 29) {
        throw error;
      }
      await sleep(1000);
    }
  }
}

async function runSql(pool, sql, values = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, values);
  } finally {
    client.release();
  }
}

async function withPostgresContainer(fn) {
  const containerName = `cotsel-shared-db-test-${process.pid}-${Date.now()}`;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=postgres',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);

  try {
    await waitForPostgres(containerName);
    const port = docker(['port', containerName, '5432/tcp']).split(':').pop();
    await fn({ containerName, port: Number.parseInt(port, 10) });
  } finally {
    try {
      docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // best effort cleanup
    }
  }
}

async function createAdminPool(port) {
  return new Pool({
    host: '127.0.0.1',
    port,
    database: 'postgres',
    user: 'postgres',
    password: 'postgres',
  });
}

test(
  'runtime roles only reach service tables when grants and app.service_name both match',
  { timeout: 120000, skip: !dockerAvailable },
  async () => {
    await withPostgresContainer(async ({ port }) => {
      const adminPool = await createAdminPool(port);

      try {
        await runSql(adminPool, 'CREATE DATABASE service_db');
        await runSql(
          adminPool,
          "CREATE ROLE reconciliation_runtime LOGIN PASSWORD 'runtime-pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
        );
        await runSql(
          adminPool,
          "CREATE ROLE reconciliation_migrator LOGIN PASSWORD 'migration-pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
        );
        await runSql(
          adminPool,
          "CREATE ROLE unrelated_runtime LOGIN PASSWORD 'other-pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
        );
        await runSql(adminPool, 'GRANT CONNECT ON DATABASE service_db TO reconciliation_runtime');
        await runSql(adminPool, 'GRANT CONNECT ON DATABASE service_db TO reconciliation_migrator');
        await runSql(adminPool, 'GRANT CONNECT ON DATABASE service_db TO unrelated_runtime');

        const adminServiceDbPool = new Pool({
          host: '127.0.0.1',
          port,
          database: 'service_db',
          user: 'postgres',
          password: 'postgres',
        });

        try {
          await runSql(adminServiceDbPool, 'REVOKE CREATE ON SCHEMA public FROM PUBLIC');
          await runSql(
            adminServiceDbPool,
            'GRANT USAGE ON SCHEMA public TO reconciliation_runtime',
          );
          await runSql(adminServiceDbPool, 'GRANT USAGE ON SCHEMA public TO unrelated_runtime');
          await runSql(
            adminServiceDbPool,
            'GRANT USAGE, CREATE ON SCHEMA public TO reconciliation_migrator',
          );
        } finally {
          await adminServiceDbPool.end();
        }

        const migrationPool = createServicePool({
          serviceName: 'reconciliation',
          connectionRole: 'migration',
          runtimeDbUser: 'reconciliation_runtime',
          host: '127.0.0.1',
          port,
          database: 'service_db',
          user: 'reconciliation_migrator',
          password: 'migration-pass',
          max: 1,
        });

        try {
          const schema = fs.readFileSync(
            path.resolve(__dirname, '../reconciliation/src/database/schema.sql'),
            'utf8',
          );
          await migrationPool.query(schema);
        } finally {
          await migrationPool.end();
        }

        const runtimePool = createServicePool({
          serviceName: 'reconciliation',
          connectionRole: 'runtime',
          runtimeDbUser: 'reconciliation_runtime',
          host: '127.0.0.1',
          port,
          database: 'service_db',
          user: 'reconciliation_runtime',
          password: 'runtime-pass',
          max: 1,
        });

        try {
          await runSql(
            runtimePool,
            "INSERT INTO reconcile_runs (run_key, mode, status) VALUES ('run-1', 'once', 'completed')",
          );
          const result = await runSql(runtimePool, 'SELECT run_key FROM reconcile_runs');
          assert.deepEqual(
            result.rows.map((row) => row.run_key),
            ['run-1'],
          );
        } finally {
          await runtimePool.end();
        }

        const wrongServicePool = createServicePool({
          serviceName: 'gateway',
          connectionRole: 'runtime',
          runtimeDbUser: 'reconciliation_runtime',
          host: '127.0.0.1',
          port,
          database: 'service_db',
          user: 'reconciliation_runtime',
          password: 'runtime-pass',
          max: 1,
        });

        try {
          const filteredResult = await runSql(
            wrongServicePool,
            'SELECT run_key FROM reconcile_runs',
          );
          assert.equal(filteredResult.rowCount, 0);
          await assert.rejects(
            () =>
              runSql(
                wrongServicePool,
                "INSERT INTO reconcile_runs (run_key, mode, status) VALUES ('run-2', 'once', 'completed')",
              ),
            /row-level security policy/i,
          );
          const blockedUpdate = await runSql(
            wrongServicePool,
            "UPDATE reconcile_runs SET status = 'failed' WHERE run_key = 'run-1'",
          );
          assert.equal(blockedUpdate.rowCount, 0);

          const blockedDelete = await runSql(
            wrongServicePool,
            "DELETE FROM reconcile_runs WHERE run_key = 'run-1'",
          );
          assert.equal(blockedDelete.rowCount, 0);
        } finally {
          await wrongServicePool.end();
        }

        const missingServicePool = new Pool({
          host: '127.0.0.1',
          port,
          database: 'service_db',
          user: 'reconciliation_runtime',
          password: 'runtime-pass',
        });

        try {
          const filteredResult = await runSql(
            missingServicePool,
            'SELECT run_key FROM reconcile_runs',
          );
          assert.equal(filteredResult.rowCount, 0);
          await assert.rejects(
            () =>
              runSql(
                missingServicePool,
                "INSERT INTO reconcile_runs (run_key, mode, status) VALUES ('run-3', 'once', 'completed')",
              ),
            /row-level security policy/i,
          );
          const blockedUpdate = await runSql(
            missingServicePool,
            "UPDATE reconcile_runs SET status = 'failed' WHERE run_key = 'run-1'",
          );
          assert.equal(blockedUpdate.rowCount, 0);
        } finally {
          await missingServicePool.end();
        }

        const unrelatedPool = createServicePool({
          serviceName: 'reconciliation',
          connectionRole: 'runtime',
          runtimeDbUser: 'unrelated_runtime',
          host: '127.0.0.1',
          port,
          database: 'service_db',
          user: 'unrelated_runtime',
          password: 'other-pass',
          max: 1,
        });

        try {
          await assert.rejects(
            () => runSql(unrelatedPool, 'SELECT run_key FROM reconcile_runs'),
            /permission denied/i,
          );
        } finally {
          await unrelatedPool.end();
        }
      } finally {
        await adminPool.end();
      }
    });
  },
);
