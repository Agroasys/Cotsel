'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Pool } = require('pg');

const { createServicePool } = require('./index');
const { runVersionedMigrations } = require('./migrate');
const {
  createAdminPool,
  dockerAvailable,
  runSql,
  withPostgresContainer,
} = require('./postgres-test-support');

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
          const migrationResult = await runVersionedMigrations({
            pool: migrationPool,
            serviceName: 'reconciliation',
            manifestPath: path.resolve(__dirname, '../reconciliation/src/database/migrations.json'),
          });
          assert.equal(migrationResult.applied.length, 1);
          const replayResult = await runVersionedMigrations({
            pool: migrationPool,
            serviceName: 'reconciliation',
            manifestPath: path.resolve(__dirname, '../reconciliation/src/database/migrations.json'),
          });
          assert.equal(replayResult.applied.length, 0);
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
          await assert.rejects(
            () => runSql(runtimePool, 'CREATE TABLE runtime_ddl_must_fail (id INTEGER)'),
            /permission denied/i,
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
