'use strict';

const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const POSTGRES_IMAGE = process.env.SHARED_DB_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function detectDocker() {
  try {
    docker(['version']);
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = detectDocker();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createAdminPool(port) {
  return new Pool({
    host: '127.0.0.1',
    port,
    database: 'postgres',
    user: 'postgres',
    password: 'postgres',
  });
}

async function waitForPostgres(containerName, port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let pool;
    try {
      docker(['exec', containerName, 'pg_isready', '-U', 'postgres']);
      pool = await createAdminPool(port);
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === 29) {
        throw error;
      }
      await sleep(1000);
    } finally {
      if (pool) {
        await pool.end().catch(() => undefined);
      }
    }
  }
}

async function runSql(pool, sql, values = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, values);
  } finally {
    client.release();
  }
}

async function withPostgresContainer(fn) {
  const containerName = `cotsel-shared-db-test-${process.pid}-${Date.now()}`;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=postgres',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);

  try {
    const port = Number.parseInt(docker(['port', containerName, '5432/tcp']).split(':').pop(), 10);
    await waitForPostgres(containerName, port);
    await fn({ containerName, port });
  } catch (error) {
    try {
      const containerLogs = docker(['logs', containerName]);
      if (containerLogs) {
        console.error(`Postgres test container logs:\n${containerLogs}`);
      }
    } catch {
      // Preserve the original failure when diagnostic log collection fails.
    }
    throw error;
  } finally {
    try {
      docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // Best-effort cleanup after test failure.
    }
  }
}

module.exports = {
  createAdminPool,
  dockerAvailable,
  runSql,
  withPostgresContainer,
};
