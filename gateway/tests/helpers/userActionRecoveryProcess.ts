/** SPDX-License-Identifier: Apache-2.0 */
// Controlled local process fixture. No real RPC, signer service, or external submission.
import { Pool } from 'pg';
import { FeeData, Transaction, Wallet, type TransactionReceipt } from 'ethers';
import type { GaslessUserActionExecutionInput } from '../../src/core/gaslessExecutionTypes';
import { createPostgresSettlementStore } from '../../src/core/settlementStore';
import { SettlementService } from '../../src/core/settlementService';
import { createUserActionRequestStore } from '../../src/core/userActionEngine/requestStore';
import { verifyNonceOwnership } from '../../src/core/userActionEngine/retirement';
import { executeDormantUserAction } from '../../src/core/userActionEngine/workflow';
import { createPostgresGaslessNonceReservationStore } from '../../src/core/gaslessNonceReservationStore';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../../src/core/gaslessTransactionOutcomeStore';
import { recoverUserActionSignedIdentities } from '../../src/core/userActionEngine/recoverSignedIdentity';
import { GaslessTransactionOutcomeReconciler } from '../../src/core/gaslessTransactionOutcomeReconciler';
import { GaslessSettlementOutcomeObserver } from '../../src/core/gaslessSettlementOutcomeObserver';
import { config } from './gaslessManagedSignerFixtures';
import type { DormantUserActionEnginePorts } from '../../src/core/userActionEngine/workflow';
import { Router } from 'express';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import { createApp } from '../../src/app';
import { createPostgresIdempotencyStore } from '../../src/core/idempotencyStore';
import { createIdempotencyMiddleware } from '../../src/middleware/idempotency';
import { createServiceAuthMiddleware, createServiceApiKeyLookup } from '../../src/core/serviceAuth';
import { parseOwnedUserAction } from '../../src/core/userActionEngine/ingress';
import { successResponse } from '../../src/responses';
import { createHttpRateLimiter } from '@agroasys/shared-edge';
import { gatewayRateLimitPolicy } from '../../src/httpSecurity';

export interface RecoveryProcessInput {
  database: string;
  input: GaslessUserActionExecutionInput;
  token: string;
  mode: 'raw' | 'kms';
  operation: 'execute' | 'observe' | 'replay' | 'http';
  boundary?: 'claimed' | 'signing' | 'signed_identity';
  receiptStatus?: 0 | 1 | null;
}
export interface RecoveryProcessResult {
  type: 'barrier' | 'complete' | 'error' | 'ready';
  stage?: string;
  port?: number;
  requestId?: string;
  signerCalls: number;
  broadcastCalls: number;
  reads: number;
  denied?: boolean;
}
async function send(message: RecoveryProcessResult): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    process.send!(message, (error) => (error ? reject(error) : resolve())),
  );
}
process.once('message', (message: RecoveryProcessInput) => {
  void run(message).catch(async () => {
    // Never emit the accepted body, signed bytes, or raw provider diagnostics.
    await send({ type: 'error', signerCalls: 0, broadcastCalls: 0, reads: 0 });
    process.exit(1);
  });
});
async function run(message: RecoveryProcessInput) {
  if (!/^ua_[0-9a-f]{32}$/.test(message.database)) throw new Error('Scratch database required');
  const pool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    database: message.database,
    user: message.database,
    password: 'local-test-only',
    options: '-c app.service_name=gateway',
    max: 4,
  });
  let signerCalls = 0,
    broadcastCalls = 0,
    reads = 0;
  const input = message.input;
  const now = () => new Date(Number(input.userAuthorization.deadline) * 1000 - 300_000);
  const store = createPostgresSettlementStore(pool);
  const service = new SettlementService({ ...config, settlementCallbackEnabled: false }, store);
  const requests = createUserActionRequestStore(pool, 60, () => now().getTime());
  const outcomes = createPostgresGaslessTransactionOutcomeRecorder(pool, 'user_action');
  const receipt = (hash: string, status = 1) =>
    ({
      hash,
      to: input.contractAddress,
      status,
      blockNumber: 101,
      blockHash: '0x' + 'a'.repeat(64),
      gasUsed: 90_000n,
      gasPrice: 2n,
    }) as TransactionReceipt;
  const finality = {
    verifyReceipt: async (chain: number, hash: string, value: TransactionReceipt) => ({
      policyVersion: 'gasless_dual_rpc_finalized_v1' as const,
      chainId: String(chain),
      transactionHash: hash,
      blockNumber: String(value.blockNumber),
      blockHash: value.blockHash,
      finalizedBlockNumber: '200',
      finalizedBlockHash: '0x' + 'f'.repeat(64),
      rpcWitnesses: ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)],
    }),
    revalidateBlock: async () => 'canonical' as const,
  };
  const pause = async (stage: RecoveryProcessInput['boundary']) => {
    if (message.boundary !== stage) return;
    const request = await requests.inspect(input.sourceApiKeyId!, input.sourceOperationId!);
    await send({
      type: 'barrier',
      stage,
      requestId: request!.requestId,
      signerCalls,
      broadcastCalls,
      reads,
    });
    // IPC remains connected; parent terminates this exact child with SIGKILL.
    await new Promise<void>(() => {});
  };
  try {
    if (message.operation === 'observe') {
      // These owning observation ports have no signer or submission capability.
      const provider = {
        getTransactionReceipt: async (hash: string) => {
          reads++;
          return message.receiptStatus === null || message.receiptStatus === undefined
            ? null
            : receipt(hash, message.receiptStatus);
        },
        getTransaction: async () => null,
        getTransactionCount: async () => 7,
      };
      await recoverUserActionSignedIdentities(pool, outcomes, 25);
      await new GaslessTransactionOutcomeReconciler(
        outcomes,
        provider,
        new GaslessSettlementOutcomeObserver(store, service),
        1000,
        finality,
      ).processUnresolved();
    } else {
      const wallet = new Wallet('0x' + '77'.repeat(32));
      const sign = async (tx: Parameters<Wallet['signTransaction']>[0]) => {
        signerCalls++;
        if (message.operation === 'replay') throw new Error('Replay cannot sign');
        return wallet.signTransaction(tx);
      };
      const ports: DormantUserActionEnginePorts = {
        chainId: input.chainId,
        escrowAddress: input.contractAddress,
        usdcAddress: message.token,
        requestMaxTtlSeconds: 900,
        now,
        loadHandoff: (id) => store.getHandoff(id),
        verifyFunding: async () => {
          if (message.operation === 'replay') throw new Error('No fresh proof in replay');
        },
        verifyNonceOwnership: (value) =>
          verifyNonceOwnership(pool, value, async () => ({ status: 'unavailable' })),
        requests: {
          ...requests,
          claim: async (request) => {
            const claim = await requests.claim(request);
            await pause('claimed');
            return claim;
          },
          beginSigning: async (...args) => {
            await requests.beginSigning(...args);
            await pause('signing');
          },
        },
        settlementService: service,
        assertBroadcastOpen: () => {},
        assertCapacityOpen: () => {},
        custody: {
          chainId: input.chainId,
          escrowAddress: input.contractAddress,
          usdcAddress: message.token,
          provider: {
            call: async () => '0x',
            estimateGas: async () => 100_000n,
            getBalance: async () => 1_000_000n,
            getFeeData: async () => new FeeData(null, 2n, 1n),
            getTransactionCount: async () => 7,
            broadcastTransaction: async (bytes) => {
              broadcastCalls++;
              if (message.operation === 'replay') throw new Error('Replay cannot submit');
              const hash = Transaction.from(bytes).hash!;
              return { hash, wait: async () => receipt(hash) } as never;
            },
          },
          nonces: createPostgresGaslessNonceReservationStore(pool),
          outcomes: {
            ...outcomes,
            recordPrepared: async (identity) => {
              await pause('signed_identity');
              await outcomes.recordPrepared(identity);
            },
          },
          finality,
          maxGasLimit: 200_000n,
          maxFeePerGasWei: 10n,
          maxNativeCostWei: 1_000_000n,
          minBalanceWei: 100n,
          receiptTimeoutMs: 100,
          signer:
            message.mode === 'raw'
              ? {
                  mode: 'raw',
                  wallet: { getAddress: async () => wallet.address, signTransaction: sign },
                }
              : {
                  mode: 'kms',
                  transport: {
                    getSignerAddress: async () => wallet.address,
                    signTransaction: async (request) => {
                      const tx = request.transaction;
                      const bytes = await sign({
                        chainId: tx.chainId,
                        to: tx.to,
                        data: tx.data,
                        value: tx.value,
                        nonce: tx.nonce,
                        gasLimit: tx.gasLimit,
                        type: tx.type,
                        ...(tx.type === 2
                          ? {
                              maxFeePerGas: tx.maxFeePerGasWei,
                              maxPriorityFeePerGas: tx.maxPriorityFeePerGasWei,
                            }
                          : { gasPrice: tx.gasPriceWei }),
                      });
                      return {
                        requestId: request.requestId,
                        intentHash: request.intentHash,
                        signerAddress: wallet.address,
                        signedTransaction: bytes,
                      };
                    },
                  },
                },
        },
      };
      if (message.operation === 'http') {
        // Test-only ingress exercises real auth/idempotency around the controlled INTERNAL engine.
        // It neither replaces nor reaches any production public execution guard.
        const requestRateLimiter = await createHttpRateLimiter({
          enabled: true,
          nodeEnv: 'test',
          keyPrefix: 'gateway-user-action-recovery-test',
          classifyRoute: gatewayRateLimitPolicy,
        });
        let server: import('http').Server | undefined;
        try {
          const router = Router();
          const nonces = createInMemoryNonceStore();
          router.post(
            '/test-only/user-action',
            requestRateLimiter.middleware,
            createServiceAuthMiddleware({
              enabled: true,
              maxSkewSeconds: 300,
              nonceTtlSeconds: 600,
              consumeNonce: nonces.consume.bind(nonces),
              lookupApiKey: createServiceApiKeyLookup(
                JSON.stringify([{ id: 'owner', secret: 'test-secret', active: true }]),
              ),
            }),
            createIdempotencyMiddleware(createPostgresIdempotencyStore(pool)),
            (req, res, next) => {
              void executeDormantUserAction(
                ports,
                parseOwnedUserAction(
                  req.body,
                  req.requestContext!.requestId,
                  req.serviceAuth!.apiKeyId,
                ),
              )
                .then((record) =>
                  res
                    .status(202)
                    .json(
                      successResponse({ requestId: record.requestId, signerCalls, broadcastCalls }),
                    ),
                )
                .catch(next);
            },
          );
          const app = createApp(config, {
            version: 'test',
            commitSha: 'fixture',
            buildTime: 'fixture',
            readinessCheck: async () => [],
            extraRouter: router,
          });
          server = await new Promise<import('http').Server>((resolve) => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
          });
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Test-only address missing');
          await send({ type: 'ready', port: address.port, signerCalls, broadcastCalls, reads });
          await new Promise<void>((resolve) => process.once('message', () => resolve()));
        } finally {
          if (server) {
            await new Promise<void>((resolve, reject) =>
              server!.close((error) => (error ? reject(error) : resolve())),
            );
          }
          await requestRateLimiter.close();
        }
      } else {
        try {
          await executeDormantUserAction(ports, input);
        } catch {
          await send({ type: 'complete', denied: true, signerCalls, broadcastCalls, reads });
          return;
        }
      }
    }
    const request = await requests.inspect(input.sourceApiKeyId!, input.sourceOperationId!);
    await send({
      type: 'complete',
      requestId: request!.requestId,
      signerCalls,
      broadcastCalls,
      reads,
    });
  } finally {
    await pool.end();
    process.disconnect?.();
  }
}
