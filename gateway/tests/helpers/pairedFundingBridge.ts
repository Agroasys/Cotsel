/** SPDX-License-Identifier: Apache-2.0 */
// Funding composition for the existing paired HTTPS harness. Production modules never import this file.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:https';
import { FeeData, JsonRpcProvider, Wallet } from 'ethers';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import { createHttpRateLimiter } from '@agroasys/shared-edge';
import { createApp } from '../../src/app';
import { gatewayRateLimitPolicy } from '../../src/httpSecurity';
import { createSettlementRouter } from '../../src/routes/settlement';
import { createServiceApiKeyLookup } from '../../src/core/serviceAuth';
import { createPostgresIdempotencyStore } from '../../src/core/idempotencyStore';
import { createPostgresSettlementStore } from '../../src/core/settlementStore';
import { SettlementService } from '../../src/core/settlementService';
import { GaslessSettlementExecutionService } from '../../src/core/gaslessSettlementExecutionService';
import { createManagedSignerGaslessSettlementExecutor } from '../../src/core/gaslessManagedSignerExecutor';
import { createPostgresGaslessNonceReservationStore } from '../../src/core/gaslessNonceReservationStore';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../../src/core/gaslessTransactionOutcomeStore';
import { createPostgresGaslessRelayerBroadcastLock } from '../../src/core/gaslessRelayerBroadcastLock';
import { createUserActionEnginePostgres } from './userActionEnginePostgres';
import { config } from './gaslessManagedSignerFixtures';
let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>> | undefined;
let server: Server | undefined;
let limiter: Awaited<ReturnType<typeof createHttpRateLimiter>> | undefined;
const providers: JsonRpcProvider[] = [];
let signatures = 0,
  broadcasts = 0;
async function close() {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await limiter?.close();
  limiter = undefined;
  providers.forEach((provider) => provider.destroy());
  await db?.close();
  db = undefined;
}
async function start(input: {
  rpcUrls: string[];
  escrowAddress: string;
  tokenAddress: string;
  secret: string;
}) {
  if (
    !process.send ||
    process.env.COTSEL_PAIRED_LIFECYCLE_FIXTURE !== 'true' ||
    input.rpcUrls.length !== 2 ||
    input.rpcUrls.some((url) => !['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
  )
    throw new Error('Explicit loopback paired fixture required');
  db = await createUserActionEnginePostgres();
  providers.push(
    ...input.rpcUrls.map(
      (url) => new JsonRpcProvider(url, 84532, { cacheTimeout: -1, staticNetwork: true }),
    ),
  );
  const c = {
    ...config,
    chainId: 84532,
    escrowAddress: input.escrowAddress,
    usdcAddress: input.tokenAddress,
    rpcUrl: input.rpcUrls[0]!,
    rpcFallbackUrls: [input.rpcUrls[1]!],
    gaslessSignerCustodyMode: 'kms' as const,
    gaslessMaxFeePerGasWei: 10n,
    gaslessMaxGasLimit: 1500000n,
    gaslessReceiptTimeoutMs: 1000,
  };
  const store = createPostgresSettlementStore(db.runtime),
    settlement = new SettlementService(c, store);
  const wallet = new Wallet('0x' + '77'.repeat(32));
  const executor = createManagedSignerGaslessSettlementExecutor(c, {
    recordTransactionOutcome: createPostgresGaslessTransactionOutcomeRecorder(db.runtime),
    nonceReservationStore: createPostgresGaslessNonceReservationStore(db.runtime),
    provider: {
      call: (tx) => providers[0]!.call(tx),
      estimateGas: (tx) => providers[0]!.estimateGas(tx),
      getBalance: (address) => providers[0]!.getBalance(address),
      getFeeData: async () => new FeeData(null, 2n, 1n),
      getTransactionCount: (address, tag) => providers[0]!.getTransactionCount(address, tag),
      broadcastTransaction: async (signed) => {
        broadcasts++;
        const results = await Promise.all(
          providers.map((provider) => provider.broadcastTransaction(signed)),
        );
        await Promise.all(results.map((result) => result.wait()));
        return results[0]!;
      },
    },
    // Backend independently verifies retained indexer/reconciliation and finalized RPC evidence later.
    finalityVerifier: {
      verifyReceipt: async () => null,
      revalidateBlock: async () => 'unavailable',
    },
    signerTransport: {
      getSignerAddress: async () => wallet.address,
      signTransaction: async (request) => {
        signatures++;
        const tx = request.transaction;
        return {
          requestId: request.requestId,
          intentHash: request.intentHash,
          signerAddress: wallet.address,
          signedTransaction: await wallet.signTransaction({
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
          }),
        };
      },
    },
  });
  const service = new GaslessSettlementExecutionService(settlement, store, executor, {
    chainId: 84532,
    escrowAddress: c.escrowAddress,
    usdcAddress: c.usdcAddress,
    requestMaxTtlSeconds: 900,
    broadcastLock: createPostgresGaslessRelayerBroadcastLock(db.runtime),
  });
  const nonces = createInMemoryNonceStore();
  const lookup = createServiceApiKeyLookup(
    JSON.stringify([{ id: 'owner', secret: input.secret, active: true }]),
  );
  const router = createSettlementRouter({
    config: c,
    settlementService: settlement,
    settlementStore: store,
    gaslessSettlementService: service,
    nonceStore: nonces,
    idempotencyStore: createPostgresIdempotencyStore(db.runtime),
    lookupServiceApiKey: lookup,
  });
  limiter = await createHttpRateLimiter({
    enabled: true,
    nodeEnv: 'test',
    keyPrefix: 'gateway-paired-funding-test',
    classifyRoute: gatewayRateLimitPolicy,
  });
  const app = createApp(c, {
    version: 'paired-funding-fixture',
    commitSha: 'fixture',
    buildTime: 'fixture',
    readinessCheck: async () => [],
    requestRateLimitMiddleware: limiter.middleware,
    extraRouter: router,
  });
  const tls = process.env.PAIRED_TEST_TLS_DIRECTORY!;
  server = createServer(
    {
      key: readFileSync(path.join(tls, 'server.key')),
      cert: readFileSync(path.join(tls, 'server.crt')),
    },
    app,
  );
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback required');
  return { event: 'ready', baseUrl: `https://127.0.0.1:${address.port}/api/dashboard-gateway/v1` };
}
let queue = Promise.resolve();
process.on('message', (input: { command: string } & Parameters<typeof start>[0]) => {
  queue = queue.then(async () => {
    try {
      if (input.command === 'start') process.send!(await start(input));
      else if (input.command === 'inspect') {
        const records = await db!.runtime.query(
          'SELECT transaction_hash,calldata_hash FROM gasless_transaction_outcomes ORDER BY created_at',
        );
        process.send!({ event: 'inventory', signatures, broadcasts, records: records.rows });
      } else if (input.command === 'close') {
        await close();
        process.send!({ event: 'closed' });
        process.disconnect?.();
      } else throw new Error('Unsupported paired command');
    } catch {
      process.send?.({ event: 'failed' });
    }
  });
});
process.once('disconnect', () => {
  void close().finally(() => process.exit());
});
