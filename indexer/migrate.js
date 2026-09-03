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

function loadIndexerMigrationManifest(manifestPath) {
  return loadMigrationManifest(manifestPath).map((migration) => {
    delete require.cache[require.resolve(migration.absolutePath)];
    const Migration = require(migration.absolutePath);
    if (typeof Migration !== 'function') {
      throw new Error(`Indexer migration ${migration.version} must export a migration class`);
    }

    const instance = new Migration();
    const typeormName = instance.name || Migration.name;
    const timestamp = typeormName.slice(-13);
    if (!/^\d{13}$/.test(timestamp) || timestamp !== migration.version) {
      throw new Error(
        `Indexer migration ${migration.version} does not match TypeORM identity ${typeormName}`,
      );
    }
    return { ...migration, typeormName };
  });
}

async function loadIndexerHistory(client) {
  const tableResult = await client.query(
    `SELECT to_regclass('public.migrations')::text AS migration_table`,
  );
  if (!tableResult.rows[0]?.migration_table) {
    return { checksumColumn: false, rows: [] };
  }

  const columnResult = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'migrations'
         AND column_name = 'checksum'
     ) AS checksum_column`,
  );
  const checksumColumn = columnResult.rows[0]?.checksum_column === true;
  const rows = await client.query(
    checksumColumn
      ? `SELECT timestamp::text, name, checksum FROM public.migrations ORDER BY id`
      : `SELECT timestamp::text, name, NULL::text AS checksum FROM public.migrations ORDER BY id`,
  );
  return { checksumColumn, rows: rows.rows };
}

function validateIndexerHistory(migrations, history, { requireAll = false } = {}) {
  const byName = new Map(migrations.map((migration) => [migration.typeormName, migration]));
  const appliedNames = new Set();

  for (const applied of history.rows) {
    const declared = byName.get(applied.name);
    if (!declared || applied.timestamp !== declared.version) {
      throw new Error(
        `Applied indexer migration ${applied.name} is missing from the immutable manifest`,
      );
    }
    if (!history.checksumColumn || !applied.checksum) {
      throw new Error(
        `Applied indexer migration ${applied.name} has no durable checksum; stop and create a reviewed adoption design`,
      );
    }
    if (applied.checksum.trim() !== declared.checksum) {
      throw new Error(
        `Applied indexer migration ${applied.name} does not match the immutable manifest`,
      );
    }
    appliedNames.add(applied.name);
  }

  for (const [index, applied] of history.rows.entries()) {
    const expected = migrations[index];
    if (!expected || applied.name !== expected.typeormName) {
      throw new Error(
        `Indexer migration history is not an ordered manifest prefix; migration ${expected?.version ?? applied.timestamp} is missing before ${applied.timestamp}`,
      );
    }
  }

  if (requireAll && appliedNames.size !== migrations.length) {
    const pending = migrations.find((migration) => !appliedNames.has(migration.typeormName));
    throw new Error(
      `Indexer schema is not current; migration ${pending?.version ?? 'history'} is missing`,
    );
  }
}

async function recordIndexerChecksums(client, migrations) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE public.migrations ADD COLUMN IF NOT EXISTS checksum CHAR(64)`);
    await client.query('LOCK TABLE public.migrations IN SHARE ROW EXCLUSIVE MODE');
    const history = await loadIndexerHistory(client);
    const declaredByName = new Map(
      migrations.map((migration) => [migration.typeormName, migration]),
    );

    for (const applied of history.rows) {
      const declared = declaredByName.get(applied.name);
      if (!declared || applied.timestamp !== declared.version) {
        throw new Error(
          `Applied indexer migration ${applied.name} is missing from the immutable manifest`,
        );
      }
      if (applied.checksum && applied.checksum.trim() !== declared.checksum) {
        throw new Error(
          `Applied indexer migration ${applied.name} does not match the immutable manifest`,
        );
      }
      if (!applied.checksum) {
        await client.query(
          `UPDATE public.migrations
           SET checksum = $1
           WHERE timestamp = $2 AND name = $3 AND checksum IS NULL`,
          [declared.checksum, Number(declared.version), declared.typeormName],
        );
      }
    }

    validateIndexerHistory(migrations, await loadIndexerHistory(client), { requireAll: true });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function runLockedIndexerMigration({
  pool,
  command,
  args,
  commandOptions,
  migrations,
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
    validateIndexerHistory(migrations, await loadIndexerHistory(client));
    await execute(command, args, commandOptions);
    await recordIndexerChecksums(client, migrations);
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
  const databaseSchema = process.env.DB_SCHEMA?.trim() || 'public';
  if (databaseSchema !== 'public') {
    throw new Error('DB_SCHEMA must be public for checksum-enforced indexer migrations');
  }
  const manifestPath = path.resolve(__dirname, 'db/migrations.json');
  const migrations = loadIndexerMigrationManifest(manifestPath);

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
      migrations,
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

module.exports = {
  loadIndexerHistory,
  loadIndexerMigrationManifest,
  main,
  positiveInteger,
  recordIndexerChecksums,
  runCommand,
  runLockedIndexerMigration,
  validateIndexerHistory,
};
