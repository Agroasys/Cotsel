'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServicePool, parsePostgresSslMode } = require('@agroasys/shared-db');
const { loadMigrationManifest } = require('@agroasys/shared-db/migrate');

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Indexer migration terminated by ${signal}`
            : `Indexer migration exited with code ${String(code)}`,
        ),
      );
    });
  });
}

async function runLockedIndexerMigration({
  pool,
  command,
  args,
  commandOptions,
  lockTimeoutMs = 30000,
  execute = runCommand,
}) {
  const timeout = positiveInteger(lockTimeoutMs, 'MIGRATION_LOCK_TIMEOUT_MS');
  const client = await pool.connect();
  const lockIdentity = 'cotsel:indexer:schema-migrations';
  let lockAcquired = false;

  try {
    await client.query(`SET lock_timeout = '${timeout}ms'`);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockIdentity]);
    lockAcquired = true;
    await execute(command, args, commandOptions);
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
      }
    } finally {
      client.release();
    }
  }
}

async function main() {
  const manifestPath = path.resolve(__dirname, 'db/migrations.json');
  loadMigrationManifest(manifestPath);

  const statementTimeoutMs = positiveInteger(
    process.env.MIGRATION_STATEMENT_TIMEOUT_MS || 300000,
    'MIGRATION_STATEMENT_TIMEOUT_MS',
  );
  const password = process.env.DB_PASSWORD?.trim() || requiredEnv('DB_PASS');
  const pool = createServicePool({
    serviceName: 'indexer',
    connectionRole: 'migration',
    host: requiredEnv('DB_HOST'),
    port: positiveInteger(requiredEnv('DB_PORT'), 'DB_PORT'),
    database: requiredEnv('DB_NAME'),
    user: requiredEnv('DB_USER'),
    password,
    sslMode: parsePostgresSslMode(process.env.DB_SSL_MODE),
    max: 1,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });

  const priorPgOptions = process.env.PGOPTIONS?.trim();
  const statementTimeoutOption = `-c statement_timeout=${statementTimeoutMs}`;
  const pgOptions = priorPgOptions
    ? `${priorPgOptions} ${statementTimeoutOption}`
    : statementTimeoutOption;

  try {
    await runLockedIndexerMigration({
      pool,
      command: path.resolve(__dirname, 'node_modules/.bin/squid-typeorm-migration'),
      args: ['apply'],
      commandOptions: {
        cwd: __dirname,
        env: { ...process.env, PGOPTIONS: pgOptions },
        stdio: 'inherit',
      },
      lockTimeoutMs: process.env.MIGRATION_LOCK_TIMEOUT_MS || 30000,
    });
    process.stdout.write('indexer migrations completed successfully\n');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `Indexer migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { main, positiveInteger, runCommand, runLockedIndexerMigration };
