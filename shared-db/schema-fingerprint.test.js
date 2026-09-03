'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { computePublicSchemaFingerprint } = require('./schema-fingerprint');
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('./postgres-test-support');

test(
  'schema fingerprint detects DDL drift and ignores the migration ledger',
  { timeout: 120000, skip: !dockerAvailable },
  async () => {
    await withPostgresContainer(async ({ port }) => {
      const pool = await createAdminPool(port);
      try {
        await pool.query('CREATE TABLE fingerprint_fixture (id BIGINT PRIMARY KEY)');
        const initial = await computePublicSchemaFingerprint(pool);

        await pool.query(`
          CREATE TABLE cotsel_schema_migrations (
            service_name TEXT NOT NULL,
            version VARCHAR(14) NOT NULL,
            PRIMARY KEY (service_name, version)
          )
        `);
        assert.equal(await computePublicSchemaFingerprint(pool), initial);

        await pool.query('ALTER TABLE fingerprint_fixture ADD COLUMN value TEXT');
        assert.notEqual(await computePublicSchemaFingerprint(pool), initial);
      } finally {
        await pool.end();
      }
    });
  },
);
