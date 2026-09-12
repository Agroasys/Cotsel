/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { createPostgresGovernanceActionStore } from '../src/core/governancePostgresStore';
import type { GovernanceActionRecord } from '../src/core/governanceStore';

const POSTGRES_IMAGE = process.env.GATEWAY_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
let dockerAvailable = true;

try {
  execFileSync('docker', ['version'], { stdio: ['ignore', 'ignore', 'ignore'] });
} catch {
  dockerAvailable = false;
}

function docker(args: string[], options: Parameters<typeof execFileSync>[2] = {}): string {
  return String(
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }),
  ).trim();
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker(['exec', containerName, 'pg_isready', '-U', 'postgres']);
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function withPostgres(fn: (port: number) => Promise<void>): Promise<void> {
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
    await waitForPostgres(containerName);
    const port = Number.parseInt(docker(['port', containerName, '5432/tcp']).split(':').pop()!, 10);
    const admin = new Pool({
      host: '127.0.0.1',
      port,
      database: 'gateway_test',
      user: 'postgres',
      password: 'postgres',
      max: 1,
    });
    try {
      const client = await admin.connect();
      try {
        await client.query("CREATE ROLE gateway_runtime LOGIN PASSWORD 'gateway-runtime-test'");
        await client.query("SET app.runtime_db_user = 'gateway_runtime'");
        for (const file of [
          '../src/database/schema.sql',
          '../src/database/schema/003_gasless_transaction_outcomes.sql',
          '../src/database/schema/004_settlement_callback_delivery_leases.sql',
          '../src/database/schema/005_governance_direct_sign.sql',
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
  } finally {
    try {
      docker(['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      // Best-effort cleanup of the disposable database.
    }
  }
}

function buildAction(): GovernanceActionRecord {
  const signer = '0x00000000000000000000000000000000000000AA';
  const contract = '0x00000000000000000000000000000000000000ff';
  return {
    actionId: 'action-1',
    intentKey: 'v1|pause||||31337|signer',
    intentHash: 'a'.repeat(64),
    proposalId: null,
    category: 'pause',
    status: 'prepared',
    flowType: 'direct_sign',
    contractMethod: 'pause',
    txHash: null,
    blockNumber: null,
    tradeId: null,
    chainId: '31337',
    targetAddress: null,
    broadcastAt: null,
    createdAt: '2026-09-12T08:00:00.000Z',
    expiresAt: '2026-09-12T09:00:00.000Z',
    executedAt: null,
    requestId: 'req-1',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    actorId: 'acct-admin-1',
    endpoint: '/governance/pause/prepare',
    errorCode: null,
    errorMessage: null,
    finalSignerWallet: null,
    verificationState: 'not_started',
    verificationError: null,
    verifiedAt: null,
    monitoringState: 'not_started',
    audit: {
      reason: 'Prepare witnessed hardware-wallet governance action.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://example.test/COTSEL-641' }],
      ticketRef: 'COTSEL-641',
      actorSessionId: 'sha256:session',
      actorAccountId: 'acct-admin-1',
      actorWallet: signer,
      actorRole: 'admin',
      createdAt: '2026-09-12T08:00:00.000Z',
      requestedBy: 'user-admin-1',
      signerBindingId: 'binding-admin-1',
      signerActionClass: 'governance',
      signerEnvironment: 'staging',
      signerPolicyResult: 'authorized',
      signerBindingWallet: signer,
    },
    signing: {
      actionId: 'action-1',
      intentKey: 'v1|pause||||31337|signer',
      actionType: 'pause',
      proposalId: null,
      expiresAt: '2026-09-12T09:00:00.000Z',
      auditReference: 'COTSEL-641',
      chainId: 31337,
      contractAddress: contract,
      contractMethod: 'pause',
      args: [],
      txRequest: {
        chainId: 31337,
        from: signer,
        to: contract,
        data: '0x8456cb59',
        value: '0',
        nonce: 7,
      },
      signerWallet: signer,
      preparedPayloadHash: 'b'.repeat(64),
    },
  };
}

describe('governance direct-sign migration', () => {
  const integrationTest = dockerAvailable ? test : test.skip;

  integrationTest(
    'enforces service isolation, immutable intent, immutable tx hash and terminal states',
    async () => {
      await withPostgres(async (port) => {
        const connection = {
          host: '127.0.0.1',
          port,
          database: 'gateway_test',
          user: 'gateway_runtime',
          password: 'gateway-runtime-test',
        };
        const pool = new Pool({ ...connection, options: '-c app.service_name=gateway' });
        const wrongService = new Pool({ ...connection, options: '-c app.service_name=auth' });
        try {
          const store = createPostgresGovernanceActionStore(pool);
          const prepared = buildAction();
          await expect(store.save(prepared)).resolves.toMatchObject({
            status: 'prepared',
            audit: {
              signerBindingId: 'binding-admin-1',
              signerActionClass: 'governance',
              signerEnvironment: 'staging',
              signerPolicyResult: 'authorized',
              signerBindingWallet: prepared.signing!.signerWallet,
            },
          });

          await expect(
            store.save({
              ...prepared,
              signing: { ...prepared.signing!, auditReference: 'ATTACK-1' },
            }),
          ).rejects.toThrow('intent and audit evidence are immutable');

          const txHash = `0x${'1'.repeat(64)}`;
          const broadcast = {
            ...prepared,
            status: 'broadcast' as const,
            txHash,
            broadcastAt: '2026-09-12T08:01:00.000Z',
            finalSignerWallet: prepared.signing!.signerWallet,
            verificationState: 'verified' as const,
            verifiedAt: '2026-09-12T08:01:00.000Z',
            monitoringState: 'pending_confirmation' as const,
          };
          await expect(store.save(broadcast)).resolves.toMatchObject({ txHash });
          await expect(store.save({ ...broadcast, txHash: `0x${'2'.repeat(64)}` })).rejects.toThrow(
            'transaction hash is immutable',
          );

          const executed = {
            ...broadcast,
            status: 'executed' as const,
            monitoringState: 'finalized' as const,
            executedAt: '2026-09-12T08:05:00.000Z',
          };
          await expect(store.save(executed)).resolves.toMatchObject({ status: 'executed' });
          await expect(store.save({ ...executed, status: 'failed' as const })).rejects.toThrow(
            'terminal governance action status is immutable',
          );

          const hidden = await wrongService.query('SELECT * FROM governance_actions');
          expect(hidden.rows).toEqual([]);

          const wrongServiceStore = createPostgresGovernanceActionStore(wrongService);
          const unauthorized = {
            ...prepared,
            actionId: 'action-wrong-service',
            intentKey: 'v1|pause||||31337|wrong-service',
            signing: {
              ...prepared.signing!,
              actionId: 'action-wrong-service',
              intentKey: 'v1|pause||||31337|wrong-service',
            },
          };
          await expect(wrongServiceStore.save(unauthorized)).rejects.toThrow(
            'row-level security policy',
          );
        } finally {
          await pool.end();
          await wrongService.end();
        }
      });
    },
    120_000,
  );
});
