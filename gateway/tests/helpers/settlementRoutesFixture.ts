/** SPDX-License-Identifier: Apache-2.0 */
import type { Server } from 'http';
import { Router } from 'express';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import { createApp } from '../../src/app';
import type { GatewayConfig } from '../../src/config/env';
import { createInMemoryIdempotencyStore } from '../../src/core/idempotencyStore';
import { createServiceApiKeyLookup, createServiceAuthHeaders } from '../../src/core/serviceAuth';
import { SettlementService } from '../../src/core/settlementService';
import { createInMemorySettlementStore } from '../../src/core/settlementStore';
import {
  GaslessSettlementExecutionService,
  type GaslessExecutionSubmission,
  testExports as gaslessSettlementExecutionTestExports,
} from '../../src/core/gaslessSettlementExecutionService';
import { createCapabilitiesRouter } from '../../src/routes/capabilities';
import { createSettlementRouter } from '../../src/routes/settlement';
import type { RicardianClient } from '../../src/core/ricardianClient';

export const config: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:3005',
  authRequestTimeoutMs: 5000,
  indexerGraphqlUrl: 'http://127.0.0.1:4350/graphql',
  indexerRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcFallbackUrls: [],
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000999',
  usdcAddress: '0x0000000000000000000000000000000000000888',
  enableMutations: false,
  writeAllowlist: [],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: true,
  settlementServiceAuthApiKeysJson: JSON.stringify([
    { id: 'platform-main', secret: 'super-secret', active: true },
  ]),
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  gaslessExecutionEnabled: true,
  gaslessExecutorPrivateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  gaslessMaxGasLimit: 1_500_000n,
  gaslessMinExecutorBalanceWei: 0n,
  gaslessRequestMaxTtlSeconds: 900,
  commitSha: 'abc1234',
  buildTime: '2026-03-11T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  contractAddressRequired: true,
  allowInsecureDownstreamAuth: true,
};

export const buildConfirmedSubmission = (txHash: string): GaslessExecutionSubmission => ({
  txHash,
  receipt: {
    txHash,
    blockNumber: '12345',
    gasUsed: '210000',
    effectiveGasPriceWei: '1000000000',
    nativeCostWei: '210000000000000',
    executorAddress: '0x1111111111111111111111111111111111111111',
    executorBalanceWei: '1000000000000000000',
  },
});

export async function startServer(
  overrides: Partial<GatewayConfig> = {},
  executorOverrides: Partial<{
    simulateCreateTrade: () => Promise<{ gasEstimate?: bigint | string | number | null }>;
    executeCreateTrade: () => Promise<GaslessExecutionSubmission>;
    simulateUserAction: () => Promise<{ gasEstimate?: bigint | string | number | null }>;
    executeUserAction: () => Promise<GaslessExecutionSubmission>;
    simulateWalletUsdcTransfer: () => Promise<{
      gasEstimate?: bigint | string | number | null;
    }>;
    executeWalletUsdcTransfer: () => Promise<GaslessExecutionSubmission>;
  }> = {},
  serverOptions: Partial<{ includeProtectedRouterBeforeSettlement: boolean }> = {},
  ricardianClient?: RicardianClient,
) {
  const runtimeConfig: GatewayConfig = { ...config, ...overrides };
  const settlementStore = createInMemorySettlementStore();
  const settlementService = new SettlementService(runtimeConfig, settlementStore);
  const walletOutcomes = {
    listWalletTransferOutcomes: jest.fn(async (_source: string, _resource: string) => []),
  };
  const gaslessSettlementService = new GaslessSettlementExecutionService(
    settlementService,
    settlementStore,
    {
      async executeCreateTrade() {
        return buildConfirmedSubmission(
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        );
      },
      async simulateCreateTrade() {
        return {
          gasEstimate: 500000n,
        };
      },
      async executeUserAction() {
        return buildConfirmedSubmission(
          '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        );
      },
      async simulateUserAction() {
        return {
          gasEstimate: 300000n,
        };
      },
      async executeWalletUsdcTransfer() {
        return buildConfirmedSubmission(
          '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        );
      },
      async simulateWalletUsdcTransfer() {
        return { gasEstimate: 110000n };
      },
      ...executorOverrides,
    },
    {
      chainId: runtimeConfig.chainId,
      escrowAddress: runtimeConfig.escrowAddress,
      usdcAddress: runtimeConfig.usdcAddress,
      requestMaxTtlSeconds: runtimeConfig.gaslessRequestMaxTtlSeconds ?? 900,
      broadcastPaused: runtimeConfig.gaslessBroadcastPaused,
      signerCustodyMode: runtimeConfig.gaslessSignerCustodyMode,
      rpcFallbackCount: runtimeConfig.rpcFallbackUrls.length,
      gasLimitCap: runtimeConfig.gaslessMaxGasLimit,
      maxFeePerGasWei: runtimeConfig.gaslessMaxFeePerGasWei,
      maxNativeCostWei: runtimeConfig.gaslessMaxNativeCostWei,
      minExecutorBalanceWei: runtimeConfig.gaslessMinExecutorBalanceWei,
      lowBalanceAlertWei: runtimeConfig.gaslessLowBalanceAlertWei,
      capacityTargetTxPerDay: runtimeConfig.gaslessCapacityTargetTxPerDay,
      capacityBurstMultiplierBasisPoints: runtimeConfig.gaslessCapacityBurstMultiplierBasisPoints,
      capacitySafetyMarginBasisPoints: runtimeConfig.gaslessCapacitySafetyMarginBasisPoints,
      capacityRequiredExecutorBalanceWei: runtimeConfig.gaslessCapacityRequiredExecutorBalanceWei,
      capacityFailClosed: runtimeConfig.gaslessCapacityFailClosed,
      stuckQueueThresholdMs: runtimeConfig.gaslessStuckQueueThresholdMs,
      receiptTimeoutMs: runtimeConfig.gaslessReceiptTimeoutMs,
      repeatedFailureAlertThreshold: runtimeConfig.gaslessRepeatedFailureAlertThreshold,
    },
  );
  const nonceStore = createInMemoryNonceStore();
  const idempotencyStore = createInMemoryIdempotencyStore();
  const router = Router();
  if (serverOptions.includeProtectedRouterBeforeSettlement) {
    router.use(
      createCapabilitiesRouter({
        authSessionClient: {
          async resolveSession() {
            throw new Error('operator auth should not run for settlement service routes');
          },
          async checkReadiness() {},
        },
        config: runtimeConfig,
      }),
    );
  }
  router.use(
    createSettlementRouter({
      config: runtimeConfig,
      settlementService,
      settlementStore,
      gaslessSettlementService,
      gaslessTransactionOutcomes: walletOutcomes,
      ricardianClient,
      nonceStore,
      idempotencyStore,
      lookupServiceApiKey: createServiceApiKeyLookup(
        runtimeConfig.settlementServiceAuthApiKeysJson,
      ),
    }),
  );
  router.get('/after-settlement', (_req, res) => {
    res.status(200).json({ success: true });
  });

  const app = createApp(runtimeConfig, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`,
    gaslessSettlementService,
    walletOutcomes,
  };
}

export function withServiceAuth(
  path: string,
  body?: Record<string, unknown> | null,
  method = 'POST',
  query = '',
) {
  return createServiceAuthHeaders({
    apiKey: 'platform-main',
    apiSecret: 'super-secret',
    method,
    path,
    query,
    body: body ?? null,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: `nonce-${Math.random().toString(16).slice(2)}`,
  });
}

export function buildGaslessCreateTradeBody(
  handoffId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const authorizationDeadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const buyerAddress = '0x0000000000000000000000000000000000000200';
  const body = {
    action: 'create_trade' as const,
    handoffId,
    chainId: config.chainId,
    contractAddress: config.escrowAddress,
    expiresAt,
    buyerAddress,
    supplierAddress: '0x0000000000000000000000000000000000000100',
    totalAmount: '1000000000',
    logisticsAmount: '100000000',
    platformFeesAmount: '10000000',
    supplierFirstTranche: '445000000',
    supplierSecondTranche: '445000000',
    ricardianHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    buyerAuthorization: {
      nonce: '0',
      deadline: authorizationDeadline.toString(),
      signature:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    usdcAuthorization: {
      from: buyerAddress,
      to: config.escrowAddress,
      value: '1000000000',
      validAfter: '0',
      validBefore: authorizationDeadline.toString(),
      nonce: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      v: 27,
      r: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      s: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    },
    ...overrides,
  };

  return {
    ...body,
    payloadHash: gaslessSettlementExecutionTestExports.createPayloadHash(body),
  };
}

export function buildGaslessUserActionBody(
  handoffId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const authorizationDeadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const body = {
    action: 'open_dispute' as const,
    handoffId,
    chainId: config.chainId,
    contractAddress: config.escrowAddress,
    expiresAt,
    userAddress: '0x0000000000000000000000000000000000000200',
    tradeId: '42',
    userAuthorization: {
      nonce: '0',
      deadline: authorizationDeadline.toString(),
      signature:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    ...overrides,
  };

  return {
    ...body,
    payloadHash: gaslessSettlementExecutionTestExports.createPayloadHash(body),
  };
}
