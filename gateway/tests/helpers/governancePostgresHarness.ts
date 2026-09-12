/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const POSTGRES_IMAGE = process.env.GATEWAY_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';

function docker(args: string[], options: Parameters<typeof execFileSync>[2] = {}): string {
  return String(
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }),
  ).trim();
}

export let dockerAvailable = true;
try {
  docker(['version']);
} catch {
  dockerAvailable = false;
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
      const client = await admin.connect();
      try {
        await client.query("CREATE ROLE gateway_runtime LOGIN PASSWORD 'gateway-runtime-test'");
        await client.query("SET app.runtime_db_user = 'gateway_runtime'");
        for (const file of [
          '../../src/database/schema.sql',
          '../../src/database/schema/003_gasless_transaction_outcomes.sql',
          '../../src/database/schema/004_settlement_callback_delivery_leases.sql',
          '../../src/database/schema/005_governance_direct_sign.sql',
          '../../src/database/schema/006_governance_atomic_transitions.sql',
          '../../src/database/schema/007_governance_simulation_evidence.sql',
        ]) {
          await client.query(fs.readFileSync(path.resolve(__dirname, file), 'utf8'));
        }
      } finally {
        client.release();
      }
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
