'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServicePool, parsePostgresSslMode } = require('./index');
const { computePublicSchemaFingerprint } = require('./schema-fingerprint');

const profiles = {
  gateway: {
    before: '738188a5cd5bf31c2306777be56e2be8faf92b69b129c7f4c5fba5edd514d51a',
    user: 'cotsel_gateway_migration',
  },
  oracle: {
    // Dump replay folds varchar-array casts differently from the live RDS schema.
    // Both complete schema fingerprints were compared record by record.
    before: [
      'a8c7dd0abc1f683719c16482248c364a2111437e5538305f6938dc081beb8fe5',
      'c1330a85e0aba64a633065dcf4abefbe579e73cd75a14a3d6a30935cd439fcc2',
    ],
    user: 'cotsel_oracle_migrator',
  },
};

async function repair(client, service, profile, baseline, manifest) {
  const digest = crypto.createHash('sha256').update(baseline).digest('hex');
  if (manifest.sha256 !== digest || !manifest.baseline)
    throw new Error('Baseline identity mismatch');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `cotsel:${service}:schema-migrations`,
    ]);
    if (![profile.before].flat().includes(await computePublicSchemaFingerprint(client)))
      throw new Error('Unrecognized staging schema; no repair applied');
    const ledger = await client.query(
      "SELECT to_regclass('public.cotsel_schema_migrations') IS NOT NULL AS present",
    );
    if (ledger.rows[0].present) throw new Error('Migration ledger already exists; repair refused');
    await client.query("SELECT set_config('app.runtime_db_user', $1, true)", [
      service === 'gateway' ? 'cotsel_gateway_runtime' : 'cotsel_oracle_app',
    ]);
    const auditTableStart = baseline.indexOf(
      'CREATE TABLE IF NOT EXISTS managed_signer_validation_audit',
    );
    if (auditTableStart < 0) throw new Error('Signer audit table definition is missing');
    await client.query(service === 'gateway' ? baseline.slice(auditTableStart) : baseline);
    if (service === 'oracle') {
      // Same allowed values; rebuild the older expression in the baseline form.
      await client.query(`ALTER TABLE oracle_triggers DROP CONSTRAINT check_error_type;
        ALTER TABLE oracle_triggers ADD CONSTRAINT check_error_type CHECK
        (error_type IN ('VALIDATION', 'NETWORK', 'CONTRACT', 'TERMINAL', 'INDEXER_LAG'));`);
    }
    if ((await computePublicSchemaFingerprint(client)) !== manifest.schema_sha256)
      throw new Error('Repaired schema differs from baseline; rolling back');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const service = process.env.MIGRATION_SERVICE_NAME;
  const profile = profiles[service];
  if (
    !profile ||
    process.env.COTSEL_ENVIRONMENT !== 'staging' ||
    process.env.COTSEL_STAGING_BASELINE_REPAIR !== 'true' ||
    process.env.DB_HOST !== 'agroasys-staging.cvwaew84syk7.ap-south-1.rds.amazonaws.com' ||
    process.env.DB_NAME !== `cotsel_${service}` ||
    process.env.DB_USER !== profile.user
  ) {
    throw new Error('Repair is restricted to the identified staging database and migration role');
  }
  const manifestPath = `/app/${service}/dist/database/migrations.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).migrations[0];
  const baseline = fs.readFileSync(path.join(path.dirname(manifestPath), manifest.file), 'utf8');
  const pool = createServicePool({
    serviceName: service,
    connectionRole: 'migration',
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    runtimeDbUser: process.env.DB_RUNTIME_USER,
    sslMode: parsePostgresSslMode(process.env.DB_SSL_MODE),
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await repair(client, service, profile, baseline, manifest);
    } finally {
      client.release();
    }
    process.stdout.write(`${service} staging baseline repaired and verified\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module)
  main().catch(() => {
    process.stderr.write(
      'Staging baseline repair failed; inspect database state before retrying\n',
    );
    process.exitCode = 1;
  });
module.exports = { repair, profiles };
