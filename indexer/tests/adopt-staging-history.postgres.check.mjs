import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { adopt, schemaFingerprint, expectedFingerprint } = require('../adopt-staging-history');
const {
  loadIndexerMigrationManifest,
  loadIndexerHistory,
  validateIndexerHistory,
} = require('../migrate');
const url = process.env.REPAIR_TEST_DATABASE_URL;
if (!url) throw new Error('REPAIR_TEST_DATABASE_URL is required');
test('verified prefix adoption preserves history and rejects schema drift and repeat adoption', async () => {
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const database = `indexer_adoption_test_${process.pid}`;
  let client;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const target = new URL(url);
    target.pathname = `/${database}`;
    client = new Client({ connectionString: target.toString() });
    await client.connect();
    const migrations = loadIndexerMigrationManifest(
      new URL('../db/migrations.json', import.meta.url).pathname,
    );
    await client.query(
      'CREATE TABLE migrations(id serial PRIMARY KEY, timestamp bigint NOT NULL, name text NOT NULL)',
    );
    for (const migration of migrations.filter((m) => m.version <= '1785000000000')) {
      const Migration = require(migration.absolutePath);
      await new Migration().up({ query: (...args) => client.query(...args) });
      await client.query('INSERT INTO migrations(timestamp,name) VALUES($1,$2)', [
        migration.version,
        migration.typeormName,
      ]);
    }
    assert.equal(await schemaFingerprint(client), expectedFingerprint);
    const before = await loadIndexerHistory(client);
    await client.query('CREATE TABLE unexpected_drift(id integer)');
    await assert.rejects(adopt(client, migrations), /independently replayed/);
    assert.deepEqual(await loadIndexerHistory(client), before);
    await client.query('DROP TABLE unexpected_drift');
    await adopt(client, migrations);
    const after = await loadIndexerHistory(client);
    validateIndexerHistory(migrations, after);
    assert.deepEqual(
      after.rows.map(({ timestamp, name }) => ({ timestamp, name })),
      before.rows.map(({ timestamp, name }) => ({ timestamp, name })),
    );
    assert.equal(
      (await client.query('SELECT method FROM cotsel_adoption.indexer_history')).rows[0].method,
      'schema-replay-adoption',
    );
    assert.equal(await schemaFingerprint(client), expectedFingerprint);
    await assert.rejects(adopt(client, migrations), /unchecksummed prefix/);
  } finally {
    if (client) await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
});
