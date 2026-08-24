'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createServicePool, parsePostgresSslMode } = require('./index');

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveIntegerEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function main() {
  const serviceName = requiredEnv('MIGRATION_SERVICE_NAME');
  const schemaPath = path.resolve(requiredEnv('MIGRATION_SCHEMA_PATH'));
  const user = requiredEnv('DB_USER');

  if (!fs.statSync(schemaPath).isFile()) {
    throw new Error('MIGRATION_SCHEMA_PATH must reference a file');
  }

  const pool = createServicePool({
    serviceName,
    connectionRole: 'migration',
    host: requiredEnv('DB_HOST'),
    port: positiveIntegerEnv('DB_PORT'),
    database: requiredEnv('DB_NAME'),
    user,
    password: requiredEnv('DB_PASSWORD'),
    runtimeDbUser: requiredEnv('DB_RUNTIME_USER'),
    sslMode: parsePostgresSslMode(process.env.DB_SSL_MODE),
    max: 1,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });

  try {
    await pool.query(fs.readFileSync(schemaPath, 'utf8'));
    process.stdout.write(`${serviceName} database migration completed successfully\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `Database migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { main, positiveIntegerEnv, requiredEnv };
