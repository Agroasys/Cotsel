'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('pg');
const { repair, profiles } = require('./repair-staging-baseline');
const { computePublicSchemaFingerprint } = require('./schema-fingerprint');
const connectionString = process.env.REPAIR_TEST_DATABASE_URL;
if (!connectionString) throw new Error('REPAIR_TEST_DATABASE_URL is required');

for (const service of ['gateway', 'oracle']) {
  test(`${service} repair preserves rows and refuses unknown schema`, async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const database = `repair_test_${service}_${process.pid}`;
    let client;
    try {
      const runtime = service === 'gateway' ? 'cotsel_gateway_runtime' : 'cotsel_oracle_app';
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${runtime}') THEN CREATE ROLE ${runtime} NOLOGIN; END IF; END $$;`,
      );
      await admin.query(`CREATE DATABASE ${database}`);
      const target = new URL(connectionString);
      target.pathname = `/${database}`;
      client = new Client({ connectionString: target.toString() });
      await client.connect();
      const fixture = fs.readFileSync(
        path.join(__dirname, 'fixtures', `${service}-staging-prebaseline.sql`),
        'utf8',
      );
      // pg_dump emits psql-only random restrict markers, not database SQL.
      await client.query(
        fixture
          .split('\n')
          .filter((line) => !line.startsWith('\\'))
          .join('\n'),
      );
      await client.query('RESET search_path');
      assert.equal(await computePublicSchemaFingerprint(client), profiles[service].before);
      const baseline = fs.readFileSync(
        path.join(__dirname, '..', service, 'src', 'database', 'schema.sql'),
        'utf8',
      );
      const manifest = require(`../${service}/src/database/migrations.json`).migrations[0];
      if (service === 'gateway') {
        await client.query(
          "INSERT INTO idempotency_keys(actor_id,endpoint,idempotency_key,request_method,request_path,request_fingerprint,request_id) VALUES ('test','test','preserve','POST','/test','test','test')",
        );
      } else {
        await client.query(
          "INSERT INTO oracle_triggers(action_key,request_id,idempotency_key,trade_id,trigger_type,status) VALUES ('test','test','preserve','1','RELEASE_STAGE_1','PENDING')",
        );
      }
      await client.query('CREATE TABLE unexpected_drift(id integer)');
      await assert.rejects(
        repair(client, service, profiles[service], baseline, manifest),
        /Unrecognized staging schema/,
      );
      await client.query('DROP TABLE unexpected_drift');
      await assert.rejects(
        repair(client, service, profiles[service], baseline, {
          ...manifest,
          schema_sha256: '0'.repeat(64),
        }),
        /rolling back/,
      );
      assert.equal(await computePublicSchemaFingerprint(client), profiles[service].before);
      await repair(client, service, profiles[service], baseline, manifest);
      assert.equal(await computePublicSchemaFingerprint(client), manifest.schema_sha256);
      const table = service === 'gateway' ? 'idempotency_keys' : 'oracle_triggers';
      assert.equal(
        (await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,
        1,
      );
      await assert.rejects(
        repair(client, service, profiles[service], baseline, manifest),
        /Unrecognized staging schema/,
      );
    } finally {
      if (client) await client.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });
}
