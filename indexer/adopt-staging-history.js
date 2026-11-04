'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { createServicePool, parsePostgresSslMode } = require('../shared-db');
const { SCHEMA_RECORDS_SQL } = require('../shared-db/schema-fingerprint');
const {
  loadIndexerHistory,
  loadIndexerMigrationManifest,
  validateIndexerHistory,
} = require('./migrate');
const expectedFingerprint = 'fa88c0adae23abd4184cbcdb739cfc249049feeb565af30e3135684ce24fd521';

async function schemaFingerprint(client) {
  const rows = (await client.query(SCHEMA_RECORDS_SQL)).rows;
  const records = rows
    .filter(
      (row) =>
        !row.identity.startsWith('public.migrations.') &&
        !['public.migrations', 'public.migrations_id_seq'].includes(row.identity) &&
        !(row.record_type === 'index' && row.definition.includes('ON public.migrations ')),
    )
    .map((row) => [
      row.record_type,
      row.record_type === 'column'
        ? row.identity.replace(/\.[^.]+$/, `.${row.definition.split(',')[0]}`)
        : row.identity,
      row.definition,
    ])
    .map(JSON.stringify)
    .sort();
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

async function adopt(client, migrations) {
  const prefix = migrations.filter((migration) => migration.version <= '1785000000000');
  if (prefix.length !== 17) throw new Error('Unexpected historical manifest prefix');
  const evidence = prefix.map((migration) => ({
    version: migration.version,
    name: migration.typeormName,
    sha256: migration.checksum,
  }));
  const manifestDigest = crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  if (manifestDigest !== '8e3cf041b2f54a48da03ffa406715780b952acf0c11472dfd65c3ccb8ded1ddd')
    throw new Error('Historical source files differ from the reviewed prefix');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      'cotsel:indexer:schema-migrations',
    ]);
    await client.query('LOCK TABLE public.migrations IN SHARE ROW EXCLUSIVE MODE');
    const history = await loadIndexerHistory(client);
    if (
      history.rows.length !== prefix.length ||
      history.rows.some(
        (row, i) =>
          row.name !== prefix[i].typeormName || row.timestamp !== prefix[i].version || row.checksum,
      )
    ) {
      throw new Error('History differs from the identified unchecksummed prefix');
    }
    if ((await schemaFingerprint(client)) !== expectedFingerprint)
      throw new Error('Schema does not match the independently replayed prefix');
    await client.query('CREATE SCHEMA cotsel_adoption');
    await client.query('REVOKE ALL ON SCHEMA cotsel_adoption FROM PUBLIC');
    await client.query(`CREATE TABLE cotsel_adoption.indexer_history (
      id integer PRIMARY KEY CHECK (id = 1), method text NOT NULL,
      source_commit text NOT NULL, schema_sha256 text NOT NULL,
      adopted_manifest jsonb NOT NULL, adopted_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(
      `INSERT INTO cotsel_adoption.indexer_history VALUES (1, $1, $2, $3, $4, now())`,
      [
        'schema-replay-adoption',
        'c09b792db8637416b2239102f19c7ffe6d1320e3',
        expectedFingerprint,
        JSON.stringify(
          prefix.map((migration) => ({
            version: migration.version,
            name: migration.typeormName,
            sha256: migration.checksum,
          })),
        ),
      ],
    );
    await client.query('ALTER TABLE public.migrations ADD COLUMN IF NOT EXISTS checksum CHAR(64)');
    for (const migration of prefix) {
      const result = await client.query(
        'UPDATE public.migrations SET checksum=$1 WHERE timestamp=$2 AND name=$3 AND checksum IS NULL',
        [migration.checksum, migration.version, migration.typeormName],
      );
      if (result.rowCount !== 1) throw new Error('History changed during adoption');
    }
    validateIndexerHistory(migrations, await loadIndexerHistory(client));
    if ((await schemaFingerprint(client)) !== expectedFingerprint)
      throw new Error('Application schema changed during adoption');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (
    process.env.COTSEL_ENVIRONMENT !== 'staging' ||
    process.env.COTSEL_STAGING_HISTORY_ADOPTION !== 'true' ||
    process.env.DB_HOST !== 'agroasys-staging.cvwaew84syk7.ap-south-1.rds.amazonaws.com' ||
    process.env.DB_NAME !== 'cotsel_indexer' ||
    process.env.DB_USER !== 'cotsel_indexer_migrator'
  )
    throw new Error('Staging history adoption coordinates do not match');
  const migrations = loadIndexerMigrationManifest(path.join(__dirname, 'db/migrations.json'));
  const pool = createServicePool({
    serviceName: 'indexer',
    connectionRole: 'migration',
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    sslMode: parsePostgresSslMode(process.env.DB_SSL_MODE),
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await adopt(client, migrations);
    } finally {
      client.release();
    }
    process.stdout.write(
      'Indexer historical prefix explicitly adopted; normal migrations remain required\n',
    );
  } finally {
    await pool.end();
  }
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('Indexer staging adoption failed; no acceptance claimed\n');
    process.exitCode = 1;
  });
module.exports = { adopt, schemaFingerprint, expectedFingerprint };
