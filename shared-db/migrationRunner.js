'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const LEDGER_TABLE = 'public.cotsel_schema_migrations';

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateServiceName(serviceName) {
  if (!/^[a-z][a-z0-9-]*$/.test(serviceName)) {
    throw new Error('serviceName must contain lowercase letters, numbers, and hyphens');
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function loadMigrationFiles(directory) {
  const absoluteDirectory = path.resolve(directory);
  const stat = fs.statSync(absoluteDirectory);
  if (!stat.isDirectory()) {
    throw new Error('MIGRATION_DIRECTORY must reference a directory');
  }

  const sqlEntries = fs
    .readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'));

  if (sqlEntries.length === 0) {
    throw new Error(`No migration files found in ${absoluteDirectory}`);
  }

  const migrations = sqlEntries.map((entry) => {
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw new Error(
        `Invalid migration filename ${entry.name}; expected NNNN_lowercase_description.sql`,
      );
    }

    const filePath = path.join(absoluteDirectory, entry.name);
    const sql = fs.readFileSync(filePath, 'utf8');
    if (!sql.trim()) {
      throw new Error(`Migration ${entry.name} is empty`);
    }

    return {
      id: entry.name.slice(0, -4),
      sequence: Number.parseInt(match[1], 10),
      filename: entry.name,
      filePath,
      sql,
      checksum: sha256(sql),
    };
  });

  migrations.sort((left, right) => left.filename.localeCompare(right.filename));
  if (migrations[0].sequence === 0) {
    throw new Error('Migration sequence must start at 0001 or later');
  }
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].sequence === migrations[index].sequence) {
      throw new Error(`Duplicate migration sequence ${migrations[index].sequence}`);
    }
    if (migrations[index].sequence <= migrations[index - 1].sequence) {
      throw new Error('Migration sequence must increase monotonically');
    }
  }

  return migrations;
}

async function acquireMigrationLock(client, lockName, timeoutMs, pollIntervalMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [lockName],
    );
    if (result.rows[0]?.acquired === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for migration lock after ${timeoutMs}ms`);
}

async function releaseMigrationLock(client, lockName) {
  await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
}

async function ensureMigrationLedger(client, runtimeDbUser) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      service_name TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_by TEXT NOT NULL DEFAULT CURRENT_USER,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      PRIMARY KEY (service_name, migration_id)
    )
  `);
  await client.query(`REVOKE ALL ON TABLE ${LEDGER_TABLE} FROM PUBLIC`);

  if (runtimeDbUser) {
    const revoke = await client.query(
      `SELECT format('REVOKE ALL ON TABLE ${LEDGER_TABLE} FROM %I', $1::text) AS statement`,
      [runtimeDbUser],
    );
    await client.query(revoke.rows[0].statement);
  }
}

async function readAppliedMigrations(client, serviceName) {
  const result = await client.query(
    `SELECT migration_id, checksum_sha256
       FROM ${LEDGER_TABLE}
      WHERE service_name = $1
      ORDER BY migration_id`,
    [serviceName],
  );
  return new Map(result.rows.map((row) => [row.migration_id, row.checksum_sha256]));
}

function validateAppliedHistory(applied, migrations) {
  const available = new Set(migrations.map((migration) => migration.id));
  for (const migrationId of applied.keys()) {
    if (!available.has(migrationId)) {
      throw new Error(`Applied migration ${migrationId} is missing from the release artifact`);
    }
  }

  let pendingMigrationSeen = false;
  for (const migration of migrations) {
    const appliedChecksum = applied.get(migration.id);
    if (!appliedChecksum) {
      pendingMigrationSeen = true;
      continue;
    }
    if (pendingMigrationSeen) {
      throw new Error(`Applied migration ${migration.id} is not a contiguous history prefix`);
    }
    if (appliedChecksum && appliedChecksum !== migration.checksum) {
      throw new Error(`Checksum mismatch for applied migration ${migration.id}`);
    }
  }
}

async function applyMigration(client, serviceName, migration, statementTimeoutMs) {
  const startedAt = Date.now();
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${statementTimeoutMs}ms`,
    ]);
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${LEDGER_TABLE}
        (service_name, migration_id, checksum_sha256, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [serviceName, migration.id, migration.checksum, Date.now() - startedAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function runVersionedMigrations(
  pool,
  {
    serviceName,
    directory,
    runtimeDbUser,
    lockTimeoutMs = 60000,
    pollIntervalMs = 100,
    statementTimeoutMs = 300000,
    onEvent = () => undefined,
  },
) {
  validateServiceName(serviceName);
  positiveInteger(lockTimeoutMs, 'lockTimeoutMs');
  positiveInteger(pollIntervalMs, 'pollIntervalMs');
  positiveInteger(statementTimeoutMs, 'statementTimeoutMs');
  const migrations = loadMigrationFiles(directory);
  const client = await pool.connect();
  const lockName = `cotsel:migrations:${serviceName}`;
  let locked = false;
  let result;

  try {
    await acquireMigrationLock(client, lockName, lockTimeoutMs, pollIntervalMs);
    locked = true;
    onEvent({ type: 'lock-acquired', serviceName });

    await ensureMigrationLedger(client, runtimeDbUser);
    const applied = await readAppliedMigrations(client, serviceName);
    validateAppliedHistory(applied, migrations);

    const appliedNow = [];
    for (const migration of migrations) {
      if (applied.has(migration.id)) {
        onEvent({ type: 'migration-skipped', serviceName, migrationId: migration.id });
        continue;
      }
      await applyMigration(client, serviceName, migration, statementTimeoutMs);
      appliedNow.push({ id: migration.id, checksum: migration.checksum });
      onEvent({ type: 'migration-applied', serviceName, migrationId: migration.id });
    }

    result = {
      serviceName,
      applied: appliedNow,
      current: migrations.map((migration) => ({
        id: migration.id,
        checksum: migration.checksum,
      })),
    };
  } catch (error) {
    if (locked) {
      try {
        await releaseMigrationLock(client, lockName);
      } catch {
        // Preserve the migration failure as the primary operational evidence.
      }
    }
    client.release(error instanceof Error ? error : true);
    throw error;
  }

  try {
    if (locked) {
      await releaseMigrationLock(client, lockName);
    }
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
  client.release();
  return result;
}

module.exports = {
  LEDGER_TABLE,
  loadMigrationFiles,
  runVersionedMigrations,
  sha256,
  validateAppliedHistory,
};
