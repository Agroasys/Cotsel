import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TypeormDatabase } from '@subsquid/typeorm-store';
import pg from 'pg';

import ProcessorStateSchemaMigration from '../db/migrations/1785100000000-ProcessorStateSchema.js';

const adminDatabaseUrl = process.env.INDEXER_MIGRATION_TEST_DATABASE_URL?.trim();
const targetDatabase = 'cotsel_indexer_entitlement_test';
const deniedDatabase = 'cotsel_indexer_entitlement_denied';
const migrationRole = 'cotsel_indexer_entitlement_migrator';
const runtimeRole = 'cotsel_indexer_entitlement_app';
const readerRole = 'cotsel_indexer_entitlement_reader';
const migrationPassword = 'migration-entitlement-test-only';
const runtimePassword = 'runtime-entitlement-test-only';
const readerPassword = 'reader-entitlement-test-only';
const indexerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function connectionUrl(database, username, password) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${database}`;
  url.username = username;
  url.password = password;
  return url.toString();
}

async function connect(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function reset(admin) {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1) AND pid <> pg_backend_pid()`,
    [[targetDatabase, deniedDatabase]],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${targetDatabase}"`);
  await admin.query(`DROP DATABASE IF EXISTS "${deniedDatabase}"`);
  await admin.query(`DROP ROLE IF EXISTS "${readerRole}"`);
  await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await admin.query(`DROP ROLE IF EXISTS "${migrationRole}"`);
}

async function expectQueryDenied(client, sql, message) {
  await assert.rejects(() => client.query(sql), /denied|owner|permission/i, message);
}

test(
  'processor state migration owns DDL while runtime and GraphQL roles remain least privilege',
  { skip: !adminDatabaseUrl, timeout: 60_000 },
  async () => {
    const adminUrl = connectionUrl(
      'postgres',
      new URL(adminDatabaseUrl).username,
      new URL(adminDatabaseUrl).password,
    );
    const admin = await connect(adminUrl);
    let migrationClient;
    let runtimeClient;
    let readerClient;

    try {
      await reset(admin);
      await admin.query(
        `CREATE ROLE "${migrationRole}" LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(
        `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(
        `CREATE ROLE "${readerRole}" LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(`CREATE DATABASE "${targetDatabase}" OWNER "${migrationRole}"`);
      await admin.query(`CREATE DATABASE "${deniedDatabase}"`);

      const targetAdmin = await connect(
        connectionUrl(
          targetDatabase,
          new URL(adminDatabaseUrl).username,
          new URL(adminDatabaseUrl).password,
        ),
      );
      try {
        await targetAdmin.query(`REVOKE ALL ON DATABASE "${targetDatabase}" FROM PUBLIC`);
        await targetAdmin.query(
          `GRANT CONNECT ON DATABASE "${targetDatabase}" TO "${migrationRole}", "${runtimeRole}", "${readerRole}"`,
        );
        await targetAdmin.query(`ALTER SCHEMA public OWNER TO "${migrationRole}"`);
        await targetAdmin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      } finally {
        await targetAdmin.end();
      }

      const deniedAdmin = await connect(
        connectionUrl(
          deniedDatabase,
          new URL(adminDatabaseUrl).username,
          new URL(adminDatabaseUrl).password,
        ),
      );
      try {
        await deniedAdmin.query(`REVOKE ALL ON DATABASE "${deniedDatabase}" FROM PUBLIC`);
      } finally {
        await deniedAdmin.end();
      }

      migrationClient = await connect(
        connectionUrl(targetDatabase, migrationRole, migrationPassword),
      );
      await migrationClient.query(`CREATE SCHEMA squid_processor AUTHORIZATION "${migrationRole}"`);
      await migrationClient.query(`
        CREATE TABLE squid_processor.template_registry (
          key text NOT NULL,
          value text NOT NULL,
          type boolean NOT NULL,
          block_number int4 NOT NULL,
          height int4 NOT NULL,
          PRIMARY KEY (key, value, type, block_number)
        )
      `);
      await migrationClient.query(`
        INSERT INTO squid_processor.template_registry (key, value, type, block_number, height)
        VALUES ('legacy', '0x01', true, 90, 90)
      `);

      const migration = new ProcessorStateSchemaMigration();
      await migration.up(migrationClient);
      await migrationClient.query(`
        INSERT INTO squid_processor.template_registry (key, value, type, block_number, height)
        VALUES ('legacy', '0x01', true, 90, 91)
      `);
      await migration.up(migrationClient);
      await assert.rejects(() => migration.down(migrationClient), /rollback is destructive/);

      await migrationClient.query(`
        INSERT INTO squid_processor.status (id, height, hash, nonce)
        VALUES (0, 100, '0x100', 0)
      `);
      await migrationClient.query(`
        INSERT INTO squid_processor.hot_block (height, hash)
        VALUES (101, '0x101')
      `);
      await migrationClient.query(`
        INSERT INTO squid_processor.hot_change_log (block_height, index, change)
        VALUES (101, 0, '{"kind":"sentinel"}'::jsonb)
      `);
      await migrationClient.query(`
        CREATE TABLE public.indexer_projection (
          id bigint PRIMARY KEY,
          value text NOT NULL
        )
      `);
      await migrationClient.query(
        `INSERT INTO public.indexer_projection (id, value) VALUES (1, 'retained')`,
      );
      await migrationClient.query(
        `GRANT USAGE ON SCHEMA public TO "${runtimeRole}", "${readerRole}"`,
      );
      await migrationClient.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}"`,
      );
      await migrationClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${readerRole}"`);
      await migrationClient.query(`REVOKE ALL ON SCHEMA squid_processor FROM PUBLIC`);
      await migrationClient.query(`GRANT USAGE ON SCHEMA squid_processor TO "${runtimeRole}"`);
      await migrationClient.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA squid_processor TO "${runtimeRole}"`,
      );

      const ownership = await migrationClient.query(`
        SELECT DISTINCT owner_row.rolname AS owner
        FROM pg_class object_row
        JOIN pg_namespace namespace_row ON namespace_row.oid = object_row.relnamespace
        JOIN pg_roles owner_row ON owner_row.oid = object_row.relowner
        WHERE namespace_row.nspname IN ('public', 'squid_processor')
          AND object_row.relkind IN ('r', 'p', 'S', 'v', 'm')
      `);
      assert.deepEqual(ownership.rows, [{ owner: migrationRole }]);

      const preservedTemplates = await migrationClient.query(
        `SELECT height FROM squid_processor.template_registry WHERE key = 'legacy' ORDER BY height`,
      );
      assert.deepEqual(
        preservedTemplates.rows.map((row) => row.height),
        [90, 91],
      );

      const savedDatabaseEnvironment = Object.fromEntries(
        ['DB_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'DB_SSL'].map((key) => [
          key,
          process.env[key],
        ]),
      );
      const parsedAdminUrl = new URL(adminDatabaseUrl);
      delete process.env.DB_URL;
      process.env.DB_HOST = parsedAdminUrl.hostname;
      process.env.DB_PORT = parsedAdminUrl.port || '5432';
      process.env.DB_NAME = targetDatabase;
      process.env.DB_USER = runtimeRole;
      process.env.DB_PASS = runtimePassword;
      process.env.DB_SSL = 'false';

      try {
        const database = new TypeormDatabase({
          initializeStateSchema: false,
          projectDir: indexerRoot,
        });
        const state = await database.connect();
        assert.equal(state.height, 100);
        assert.deepEqual(
          state.top.map((block) => ({ height: block.height, hash: block.hash })),
          [{ height: 101, hash: '0x101' }],
        );
        await database.disconnect();
      } finally {
        for (const [key, value] of Object.entries(savedDatabaseEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      runtimeClient = await connect(connectionUrl(targetDatabase, runtimeRole, runtimePassword));
      await runtimeClient.query(`UPDATE public.indexer_projection SET value = value WHERE id = 1`);
      await expectQueryDenied(
        runtimeClient,
        `CREATE TABLE public.runtime_ddl_probe (id bigint)`,
        'runtime must not create public tables',
      );
      await expectQueryDenied(
        runtimeClient,
        `ALTER TABLE squid_processor.status ADD COLUMN runtime_ddl_probe boolean`,
        'runtime must not alter processor state tables',
      );

      readerClient = await connect(connectionUrl(targetDatabase, readerRole, readerPassword));
      const projection = await readerClient.query(
        `SELECT id, value FROM public.indexer_projection ORDER BY id`,
      );
      assert.deepEqual(projection.rows, [{ id: '1', value: 'retained' }]);
      await expectQueryDenied(
        readerClient,
        `UPDATE public.indexer_projection SET value = 'modified' WHERE id = 1`,
        'reader must not update projections',
      );
      await expectQueryDenied(
        readerClient,
        `SELECT * FROM squid_processor.status`,
        'reader must not access processor state',
      );

      const deniedRuntime = new pg.Client({
        connectionString: connectionUrl(deniedDatabase, runtimeRole, runtimePassword),
      });
      await assert.rejects(() => deniedRuntime.connect(), /denied|permission/i);
      const deniedReader = new pg.Client({
        connectionString: connectionUrl(deniedDatabase, readerRole, readerPassword),
      });
      await assert.rejects(() => deniedReader.connect(), /denied|permission/i);
    } finally {
      await readerClient?.end();
      await runtimeClient?.end();
      await migrationClient?.end();
      await reset(admin);
      await admin.end();
    }
  },
);
