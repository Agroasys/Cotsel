/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const POSTGRES_IMAGE = process.env.GATEWAY_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
const USE_LOCAL_POSTGRES = process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true';

function docker(args: string[], options: Parameters<typeof execFileSync>[2] = {}): string {
  return String(
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }),
  ).trim();
}

export let dockerAvailable = USE_LOCAL_POSTGRES;
if (!USE_LOCAL_POSTGRES) {
  try {
    docker(['version']);
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
}

function connection(port: number) {
  return {
    host: '127.0.0.1',
    port,
    database: 'gateway_test',
    user: 'postgres',
    password: 'postgres',
  };
}

async function waitForPostgres(containerName: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = new Pool({ ...connection(port), connectionTimeoutMillis: 1_000, max: 1 });
    try {
      docker(['exec', containerName, 'pg_isready', '-U', 'postgres']);
      await probe.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await probe.end().catch(() => undefined);
    }
  }
}

export async function withGovernancePostgres(fn: (port: number) => Promise<void>): Promise<void> {
  if (USE_LOCAL_POSTGRES) {
    const admin = new Pool({
      host: '127.0.0.1',
      port: 5432,
      database: 'postgres',
      user: 'postgres',
    });
    try {
      const existing = await admin.query(
        `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'gateway_test') AS database,
                EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_runtime') AS role`,
      );
      if (existing.rows[0].database || existing.rows[0].role) {
        throw new Error(
          'Local PostgreSQL test database or role already exists; refusing to overwrite it',
        );
      }
      await admin.query("CREATE ROLE gateway_runtime LOGIN PASSWORD 'gateway-runtime-test'");
      await admin.query('CREATE DATABASE gateway_test');
      await prepareDatabase(5432);
      await fn(5432);
    } finally {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = 'gateway_test' AND pid <> pg_backend_pid()`,
      );
      await admin.query('DROP DATABASE IF EXISTS gateway_test');
      await admin.query('DROP ROLE IF EXISTS gateway_runtime');
      await admin.end();
    }
    return;
  }

  const containerName = `cotsel-gateway-governance-test-${process.pid}-${Date.now()}`;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=gateway_test',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);

  try {
    const port = Number.parseInt(docker(['port', containerName, '5432/tcp']).split(':').pop()!, 10);
    await waitForPostgres(containerName, port);
    const admin = new Pool({ ...connection(port), max: 1 });
    try {
      await admin.query("CREATE ROLE gateway_runtime LOGIN PASSWORD 'gateway-runtime-test'");
      await prepareDatabase(port);
      await fn(port);
    } finally {
      await admin.end();
    }
  } catch (error) {
    try {
      const logs = docker(['logs', containerName]);
      if (logs) console.error(`Postgres test container logs:\n${logs}`);
    } catch {
      // Preserve the original test failure when diagnostic collection fails.
    }
    throw error;
  } finally {
    try {
      docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // Best-effort cleanup of the disposable database.
    }
  }
}

async function prepareDatabase(port: number): Promise<void> {
  const admin = new Pool({ ...connection(port), max: 1 });
  try {
    const client = await admin.connect();
    try {
      await client.query("SET app.runtime_db_user = 'gateway_runtime'");
      for (const file of [
        '../../src/database/schema.sql',
        '../../src/database/schema/003_gasless_transaction_outcomes.sql',
        '../../src/database/schema/004_settlement_callback_delivery_leases.sql',
        '../../src/database/schema/005_governance_direct_sign.sql',
        '../../src/database/schema/006_governance_atomic_transitions.sql',
        '../../src/database/schema/007_governance_simulation_evidence.sql',
        '../../src/database/schema/008_governance_pending_hash_correction.sql',
        '../../src/database/schema/009_gasless_nonce_reservations.sql',
      ]) {
        await client.query(fs.readFileSync(path.resolve(__dirname, file), 'utf8'));
      }
    } finally {
      client.release();
    }
  } finally {
    await admin.end();
  }
}
