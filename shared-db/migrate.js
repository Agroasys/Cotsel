'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createServicePool, parsePostgresSslMode } = require('./index');

const MIGRATION_VERSION_PATTERN = /^\d{12,14}$/;
const MIGRATION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function positiveIntegerEnv(name) {
  return positiveInteger(requiredEnv(name), name);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function loadMigrationManifest(manifestPath) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(absoluteManifestPath);
  const parsed = JSON.parse(fs.readFileSync(absoluteManifestPath, 'utf8'));

  if (!parsed || !Array.isArray(parsed.migrations) || parsed.migrations.length === 0) {
    throw new Error('Migration manifest must contain at least one migration');
  }

  const seenVersions = new Set();
  let previousVersion = '';

  return parsed.migrations.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Migration manifest entry ${index} must be an object`);
    }

    const { version, name, file, sha256: expectedChecksum, baseline = false } = entry;
    if (!MIGRATION_VERSION_PATTERN.test(version)) {
      throw new Error(`Migration version ${String(version)} must contain 12 to 14 digits`);
    }
    if (!MIGRATION_NAME_PATTERN.test(name)) {
      throw new Error(`Migration ${version} has an invalid name`);
    }
    if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      throw new Error(`Migration ${version} must use a manifest-relative file path`);
    }
    if (!SHA256_PATTERN.test(expectedChecksum)) {
      throw new Error(`Migration ${version} must declare a lowercase SHA-256 checksum`);
    }
    if (seenVersions.has(version) || version <= previousVersion) {
      throw new Error('Migration versions must be unique and strictly increasing');
    }
    if (typeof baseline !== 'boolean' || (baseline && index !== 0)) {
      throw new Error('Only the first migration may declare baseline=true');
    }

    const migrationPath = path.resolve(manifestDirectory, file);
    if (!migrationPath.startsWith(`${manifestDirectory}${path.sep}`)) {
      throw new Error(`Migration ${version} resolves outside the manifest directory`);
    }

    const sql = fs.readFileSync(migrationPath, 'utf8');
    const actualChecksum = sha256(sql);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Migration ${version} checksum does not match its manifest`);
    }

    seenVersions.add(version);
    previousVersion = version;
    return { version, name, file, checksum: actualChecksum, sql, baseline };
  });
}

async function rollbackQuietly(client) {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

async function runVersionedMigrations({
  pool,
  serviceName,
  manifestPath,
  lockTimeoutMs = 30000,
  statementTimeoutMs = 300000,
}) {
  const migrations = loadMigrationManifest(manifestPath);
  const validatedLockTimeoutMs = positiveInteger(lockTimeoutMs, 'MIGRATION_LOCK_TIMEOUT_MS');
  const validatedStatementTimeoutMs = positiveInteger(
    statementTimeoutMs,
    'MIGRATION_STATEMENT_TIMEOUT_MS',
  );
  const client = await pool.connect();
  const lockIdentity = `cotsel:${serviceName}:schema-migrations`;
  let lockAcquired = false;
  let connectionReusable = true;

  try {
    await client.query(`SET lock_timeout = '${validatedLockTimeoutMs}ms'`);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockIdentity]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS cotsel_schema_migrations (
        service_name TEXT NOT NULL,
        version VARCHAR(14) NOT NULL,
        name TEXT NOT NULL,
        checksum CHAR(64) NOT NULL,
        execution_ms INTEGER NOT NULL CHECK (execution_ms >= 0),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (service_name, version)
      )
    `);

    const appliedResult = await client.query(
      `SELECT version, name, checksum
       FROM cotsel_schema_migrations
       WHERE service_name = $1
       ORDER BY version`,
      [serviceName],
    );
    const migrationsByVersion = new Map(
      migrations.map((migration) => [migration.version, migration]),
    );

    for (const applied of appliedResult.rows) {
      const declared = migrationsByVersion.get(applied.version);
      if (!declared) {
        throw new Error(`Applied migration ${applied.version} is missing from the manifest`);
      }
      if (applied.name !== declared.name || applied.checksum.trim() !== declared.checksum) {
        throw new Error(
          `Applied migration ${applied.version} does not match the immutable manifest`,
        );
      }
    }

    const appliedVersions = new Set(appliedResult.rows.map((migration) => migration.version));
    const appliedNow = [];

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      if (migration.baseline) {
        const existingObjects = await client.query(
          `SELECT 1
           FROM pg_catalog.pg_tables
           WHERE schemaname = 'public'
             AND tablename <> 'cotsel_schema_migrations'
           LIMIT 1`,
        );
        if (existingObjects.rows.length > 0) {
          throw new Error(
            `Baseline migration ${migration.version} requires an empty public schema; stop and create a reviewed adoption design`,
          );
        }
      }

      const startedAt = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL statement_timeout = '${validatedStatementTimeoutMs}ms'`);
        await client.query(migration.sql);
        const executionMs = Date.now() - startedAt;
        await client.query(
          `INSERT INTO cotsel_schema_migrations
             (service_name, version, name, checksum, execution_ms)
           VALUES ($1, $2, $3, $4, $5)`,
          [serviceName, migration.version, migration.name, migration.checksum, executionMs],
        );
        await client.query('COMMIT');
        appliedNow.push({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          executionMs,
        });
      } catch (error) {
        connectionReusable = await rollbackQuietly(client);
        throw error;
      }
    }

    return { declared: migrations.length, applied: appliedNow };
  } finally {
    if (connectionReusable) {
      try {
        if (lockAcquired) {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
        }
      } finally {
        client.release();
      }
    } else {
      client.release(true);
    }
  }
}

async function main() {
  const serviceName = requiredEnv('MIGRATION_SERVICE_NAME');
  const pool = createServicePool({
    serviceName,
    connectionRole: 'migration',
    host: requiredEnv('DB_HOST'),
    port: positiveIntegerEnv('DB_PORT'),
    database: requiredEnv('DB_NAME'),
    user: requiredEnv('DB_USER'),
    password: requiredEnv('DB_PASSWORD'),
    runtimeDbUser: requiredEnv('DB_RUNTIME_USER'),
    sslMode: parsePostgresSslMode(process.env.DB_SSL_MODE),
    max: 1,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });

  try {
    const result = await runVersionedMigrations({
      pool,
      serviceName,
      manifestPath: requiredEnv('MIGRATION_MANIFEST_PATH'),
      lockTimeoutMs: process.env.MIGRATION_LOCK_TIMEOUT_MS || 30000,
      statementTimeoutMs: process.env.MIGRATION_STATEMENT_TIMEOUT_MS || 300000,
    });
    process.stdout.write(
      `${serviceName} migrations complete: ${result.applied.length} applied, ${result.declared} declared\n`,
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

module.exports = {
  loadMigrationManifest,
  main,
  positiveInteger,
  positiveIntegerEnv,
  requiredEnv,
  runVersionedMigrations,
  sha256,
};
