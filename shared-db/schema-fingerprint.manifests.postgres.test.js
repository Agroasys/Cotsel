'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { computePublicSchemaFingerprint } = require('./schema-fingerprint');
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('./postgres-test-support');

const services = ['auth', 'gateway', 'oracle', 'reconciliation', 'ricardian', 'treasury'];

test(
  'service baseline manifests pin their resulting PostgreSQL schema',
  { timeout: 120000, skip: !dockerAvailable },
  async () => {
    await withPostgresContainer(async ({ port }) => {
      const admin = await createAdminPool(port);
      await admin.query('CREATE ROLE cotsel_fingerprint_runtime NOLOGIN');

      try {
        for (const service of services) {
          const database = `cotsel_fingerprint_${service}`;
          await admin.query(`CREATE DATABASE ${database}`);
          const pool = new Pool({
            host: '127.0.0.1',
            port,
            database,
            user: 'postgres',
            password: 'postgres',
          });

          try {
            const serviceRoot = path.resolve(__dirname, '..', service, 'src', 'database');
            const manifest = JSON.parse(
              fs.readFileSync(path.join(serviceRoot, 'migrations.json'), 'utf8'),
            );
            const baseline = manifest.migrations[0];
            assert.equal(baseline.baseline, true);
            assert.equal(baseline.adopt_existing_schema, true);
            await pool.query(`SET app.runtime_db_user = 'cotsel_fingerprint_runtime'`);
            await pool.query(fs.readFileSync(path.join(serviceRoot, baseline.file), 'utf8'));
            assert.equal(
              await computePublicSchemaFingerprint(pool),
              baseline.schema_sha256,
              `${service} baseline schema fingerprint drifted`,
            );
          } finally {
            await pool.end();
          }
        }
      } finally {
        for (const service of services) {
          await admin.query(`DROP DATABASE IF EXISTS cotsel_fingerprint_${service}`);
        }
        await admin.query('DROP ROLE IF EXISTS cotsel_fingerprint_runtime');
        await admin.end();
      }
    });
  },
);
