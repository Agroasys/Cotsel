'use strict';

const path = require('node:path');
const { createServicePool, parsePostgresSslMode } = require('./index');
const { runVersionedMigrations } = require('./migrationRunner');

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
  const migrationDirectory = path.resolve(requiredEnv('MIGRATION_DIRECTORY'));
  const user = requiredEnv('DB_USER');

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
    const result = await runVersionedMigrations(pool, {
      serviceName,
      directory: migrationDirectory,
      runtimeDbUser: requiredEnv('DB_RUNTIME_USER'),
      lockTimeoutMs: Number(process.env.MIGRATION_LOCK_TIMEOUT_MS || '60000'),
      statementTimeoutMs: Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS || '300000'),
      onEvent(event) {
        if (event.type === 'migration-applied' || event.type === 'migration-skipped') {
          process.stdout.write(
            `Database migration ${event.type}: ${event.serviceName}@${event.migrationId}\n`,
          );
        }
      },
    });
    const identities = result.current
      .map((migration) => `${serviceName}@${migration.id}:${migration.checksum}`)
      .join(',');
    process.stdout.write(
      `${serviceName} database migrations completed successfully identities=${identities}\n`,
    );
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
