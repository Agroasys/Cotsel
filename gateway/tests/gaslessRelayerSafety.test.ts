/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayConfig } from '../src/config/env';
import {
  type GaslessCreateTradeExecutionInput,
  type GaslessExecutionSubmission,
  createEthersGaslessSettlementExecutor,
  GaslessSettlementExecutionService,
  testExports as gaslessSettlementExecutionTestExports,
} from '../src/core/gaslessSettlementExecutionService';
import { SettlementService } from '../src/core/settlementService';
import { createInMemorySettlementStore, type SettlementStore } from '../src/core/settlementStore';
import type { FeeData, TransactionRequest, TransactionResponse } from 'ethers';

const config: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:4100',
  authRequestTimeoutMs: 5000,
  indexerGraphqlUrl: 'http://127.0.0.1:4350/graphql',
  indexerRequestTimeoutMs: 5000,
  rpcUrl: 'http://127.0.0.1:8545',
  rpcFallbackUrls: ['http://127.0.0.1:8546'],
  rpcReadTimeoutMs: 8000,
  chainId: 31337,
  escrowAddress: '0x0000000000000000000000000000000000000999',
  enableMutations: false,
  writeAllowlist: [],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: true,
  settlementServiceAuthApiKeysJson: '[]',
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  gaslessExecutionEnabled: true,
  gaslessRequestMaxTtlSeconds: 900,
  commitSha: 'test',
  buildTime: '2026-03-11T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: false,
  allowInsecureDownstreamAuth: true,
};

function buildConfirmedSubmission(
  txHash: string,
  executorBalanceWei: string,
): GaslessExecutionSubmission {
  return {
    txHash,
    receipt: {
      txHash,
      blockNumber: '12345',
      gasUsed: '210000',
      effectiveGasPriceWei: '1000000000',
      nativeCostWei: '210000000000000',
      executorAddress: '0x1111111111111111111111111111111111111111',
      executorBalanceWei,
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function expectGatewayError(
  promise: Promise<unknown>,
  expected: {
    statusCode: number;
    code: string;
    message: string;
  },
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toMatchObject({
    statusCode: expected.statusCode,
    code: expected.code,
  });
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe(expected.message);
}

async function createHandoff(store: SettlementStore, label: string): Promise<string> {
  const handoff = await store.createHandoff({
    platformId: 'agroasys-platform',
    platformHandoffId: `handoff-${label}`,
    tradeId: `TRD-${label}`,
    phase: 'lock',
    settlementChannel: 'cotsel_escrow',
    displayCurrency: 'USD',
    displayAmount: 1000,
    assetSymbol: 'USDC',
    assetAmount: 1000,
    requestId: `request-${label}`,
  });

  return handoff.handoffId;
}

function buildCreateTradeInput(handoffId: string, label: string): GaslessCreateTradeExecutionInput {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const authorizationDeadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const buyerAddress = '0x0000000000000000000000000000000000000200';
  const payload = {
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
    ricardianHash: `0x${label.slice(0, 1).repeat(64)}`,
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
      nonce: `0x${label.slice(0, 1).repeat(64)}`,
      v: 27,
      r: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      s: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    },
  };

  return {
    ...payload,
    payloadHash: gaslessSettlementExecutionTestExports.createPayloadHash(payload),
    requestId: `gasless-${label}`,
  };
}

function createService(
  settlementService: SettlementService,
  store: SettlementStore,
  overrides: Partial<{
    executeCreateTrade: (
      input: GaslessCreateTradeExecutionInput,
    ) => Promise<GaslessExecutionSubmission>;
    simulateCreateTrade: () => Promise<{ gasEstimate?: bigint }>;
    options: Partial<ConstructorParameters<typeof GaslessSettlementExecutionService>[3]>;
  }>,
): GaslessSettlementExecutionService {
  const defaultOptions: ConstructorParameters<typeof GaslessSettlementExecutionService>[3] = {
    chainId: config.chainId,
    escrowAddress: config.escrowAddress,
    requestMaxTtlSeconds: 900,
    signerCustodyMode: 'kms',
    rpcFallbackCount: 1,
    gasLimitCap: 1n,
    maxFeePerGasWei: 1n,
    maxNativeCostWei: 10n,
    minExecutorBalanceWei: 10n,
    lowBalanceAlertWei: 10n,
    capacityTargetTxPerDay: 1,
    capacityBurstMultiplierBasisPoints: 10_000,
    capacitySafetyMarginBasisPoints: 10_000,
    capacityRequiredExecutorBalanceWei: 10n,
    capacityFailClosed: true,
    stuckQueueThresholdMs: 1,
    receiptTimeoutMs: 1000,
    repeatedFailureAlertThreshold: 1,
  };

  return new GaslessSettlementExecutionService(
    settlementService,
    store,
    {
      simulateCreateTrade:
        overrides.simulateCreateTrade ?? (async () => ({ gasEstimate: 210000n })),
      executeCreateTrade:
        overrides.executeCreateTrade ??
        (async () =>
          buildConfirmedSubmission(
            '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            '100',
          )),
      simulateUserAction: async () => ({ gasEstimate: 210000n }),
      executeUserAction: async () =>
        buildConfirmedSubmission(
          '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          '100',
        ),
      simulateOperatorAction: async () => ({ gasEstimate: 210000n }),
      executeOperatorAction: async () =>
        buildConfirmedSubmission(
          '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          '100',
        ),
    },
    {
      ...defaultOptions,
      ...(overrides.options ?? {}),
    },
  );
}

function createFakeManagedSignerDependencies(options?: {
  balanceWei?: bigint;
  broadcastFailures?: Error[];
  maxFeePerGasWei?: bigint;
  nonceStart?: number;
  receiptAvailable?: boolean;
}): {
  provider: {
    call: jest.Mock<Promise<string>, [TransactionRequest]>;
    estimateGas: jest.Mock<Promise<bigint>, [TransactionRequest]>;
    getBalance: jest.Mock<Promise<bigint>, [string]>;
    getFeeData: jest.Mock<Promise<FeeData>, []>;
    getTransactionCount: jest.Mock<Promise<number>, [string, 'pending'?]>;
    broadcastTransaction: jest.Mock<Promise<TransactionResponse>, [string]>;
  };
  signerTransport: {
    getSignerAddress: jest.Mock<Promise<string>, []>;
    signTransaction: jest.Mock<
      Promise<string>,
      [
        {
          operation: string;
          signerAddress: string;
          transaction: {
            nonce: number;
            chainId: number;
            gasLimit: string;
            maxFeePerGasWei?: string;
          };
        },
      ]
    >;
  };
} {
  const balanceWei = options?.balanceWei ?? 100n;
  const broadcastFailures = [...(options?.broadcastFailures ?? [])];
  const maxFeePerGasWei = options?.maxFeePerGasWei ?? 1n;
  const receiptAvailable = options?.receiptAvailable ?? true;
  let nextNonce = options?.nonceStart ?? 7;
  const txResponse = {
    hash: '0x9999999999999999999999999999999999999999999999999999999999999999',
    wait: async () =>
      receiptAvailable
        ? {
            status: 1,
            blockNumber: 98765,
            gasUsed: 210000n,
            gasPrice: 1n,
          }
        : null,
  } as unknown as TransactionResponse;

  return {
    provider: {
      call: jest.fn(async (_transaction: TransactionRequest) => '0x'),
      estimateGas: jest.fn(async (_transaction: TransactionRequest) => 210000n),
      getBalance: jest.fn(async (_address: string) => balanceWei),
      getFeeData: jest.fn(
        async () =>
          ({
            maxFeePerGas: maxFeePerGasWei,
            maxPriorityFeePerGas: 1n,
            gasPrice: null,
          }) as unknown as FeeData,
      ),
      getTransactionCount: jest.fn(async (_address: string, _blockTag?: 'pending') => {
        const nonce = nextNonce;
        nextNonce += 1;
        return nonce;
      }),
      broadcastTransaction: jest.fn(async (_signedTransaction: string) => {
        const failure = broadcastFailures.shift();
        if (failure) {
          throw failure;
        }
        return txResponse;
      }),
    },
    signerTransport: {
      getSignerAddress: jest.fn(async () => '0x1111111111111111111111111111111111111111'),
      signTransaction: jest.fn(async (_request) => '0xsignedmanagedtransaction'),
    },
  };
}

describe('gasless relayer safety controls', () => {
  test('paused relayer rejects broadcasts before queueing execution', async () => {
    const store = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, store);
    const service = createService(settlementService, store, {
      options: { broadcastPaused: true },
    });
    const handoffId = await createHandoff(store, 'a');

    await expectGatewayError(service.executeCreateTrade(buildCreateTradeInput(handoffId, 'a')), {
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Gasless relayer broadcast is paused',
    });

    expect(service.getRelayerReadiness().state).toBe('paused');
    expect(service.getRelayerReadiness().queue.pending).toBe(0);
    expect(service.getRelayerReadiness().queue.active).toBe(0);
  });

  test('managed custody executor delegates signing without requiring a raw private key', async () => {
    const dependencies = createFakeManagedSignerDependencies();
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          gaslessSignerCustodyMode: 'kms',
          gaslessManagedSignerUrl: 'https://signer.example.test',
          gaslessMaxGasLimit: 1_500_000n,
          gaslessMaxFeePerGasWei: 10n,
          gaslessMaxNativeCostWei: 10_000_000n,
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );
    const input = buildCreateTradeInput('handoff-managed', 'a');

    const result = await executor.executeCreateTrade(input);

    expect(result.txHash).toBe(
      '0x9999999999999999999999999999999999999999999999999999999999999999',
    );
    expect(dependencies.signerTransport.signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        custodyMode: 'kms',
        operation: 'create_trade',
        signerAddress: '0x1111111111111111111111111111111111111111',
        transaction: expect.objectContaining({
          chainId: config.chainId,
          to: config.escrowAddress,
          nonce: 7,
          gasLimit: '210000',
          maxFeePerGasWei: '1',
        }),
      }),
    );
    expect(dependencies.provider.broadcastTransaction).toHaveBeenCalledWith(
      '0xsignedmanagedtransaction',
    );
  });

  test('managed custody executor retries with a fresh nonce after nonce drift', async () => {
    const dependencies = createFakeManagedSignerDependencies({
      broadcastFailures: [new Error('nonce too low')],
      nonceStart: 41,
    });
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          gaslessSignerCustodyMode: 'mpc',
          gaslessManagedSignerUrl: 'https://signer.example.test',
          gaslessMaxGasLimit: 1_500_000n,
          gaslessMaxFeePerGasWei: 10n,
          gaslessMaxNativeCostWei: 10_000_000n,
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );

    await executor.executeCreateTrade(buildCreateTradeInput('handoff-retry', 'b'));

    expect(dependencies.signerTransport.signTransaction).toHaveBeenCalledTimes(2);
    expect(dependencies.signerTransport.signTransaction.mock.calls[0][0].transaction.nonce).toBe(
      41,
    );
    expect(dependencies.signerTransport.signTransaction.mock.calls[1][0].transaction.nonce).toBe(
      42,
    );
    expect(dependencies.provider.broadcastTransaction).toHaveBeenCalledTimes(2);
  });

  test('managed custody executor rejects low signer balance before signing', async () => {
    const dependencies = createFakeManagedSignerDependencies({ balanceWei: 1n });
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          gaslessSignerCustodyMode: 'kms',
          gaslessManagedSignerUrl: 'https://signer.example.test',
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );

    await expectGatewayError(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-low', 'c')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless executor balance is below floor',
      },
    );
    expect(dependencies.signerTransport.signTransaction).not.toHaveBeenCalled();
  });

  test('managed custody executor rejects fee-per-gas spend cap before signing', async () => {
    const dependencies = createFakeManagedSignerDependencies({ maxFeePerGasWei: 20n });
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          gaslessSignerCustodyMode: 'mpc',
          gaslessManagedSignerUrl: 'https://signer.example.test',
          gaslessMaxGasLimit: 1_500_000n,
          gaslessMaxFeePerGasWei: 10n,
          gaslessMaxNativeCostWei: 10_000_000n,
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );

    await expectGatewayError(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-fee', 'd')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless relayer fee-per-gas cap exceeded',
      },
    );
    expect(dependencies.signerTransport.signTransaction).not.toHaveBeenCalled();
  });

  test('managed custody executor fails visibly when a broadcast receipt is unavailable', async () => {
    const dependencies = createFakeManagedSignerDependencies({ receiptAvailable: false });
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          gaslessSignerCustodyMode: 'kms',
          gaslessManagedSignerUrl: 'https://signer.example.test',
          gaslessReceiptTimeoutMs: 1000,
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );

    await expectGatewayError(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-timeout', 'e')),
      {
        statusCode: 502,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless transaction receipt was not available',
      },
    );
    expect(dependencies.signerTransport.signTransaction).toHaveBeenCalledTimes(1);
  });

  test('raw private-key executor still rejects fake KMS custody without a managed signer URL', () => {
    expect(() =>
      createEthersGaslessSettlementExecutor({
        rpcUrl: config.rpcUrl,
        rpcFallbackUrls: config.rpcFallbackUrls,
        chainId: config.chainId,
        escrowAddress: config.escrowAddress,
        gaslessExecutorPrivateKey:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        gaslessSignerCustodyMode: 'kms',
      }),
    ).toThrow('Gasless managed signer URL is not configured');
  });

  test('fail-closed capacity policy blocks broadcasts after observed low executor balance', async () => {
    const store = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, store);
    const service = createService(settlementService, store, {
      executeCreateTrade: async () =>
        buildConfirmedSubmission(
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '1',
        ),
    });
    const firstHandoffId = await createHandoff(store, 'a');
    const secondHandoffId = await createHandoff(store, 'b');

    await service.executeCreateTrade(buildCreateTradeInput(firstHandoffId, 'a'));
    expect(service.getRelayerReadiness().state).toBe('blocked');

    await expectGatewayError(
      service.executeCreateTrade(buildCreateTradeInput(secondHandoffId, 'b')),
      {
        statusCode: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless executor balance is below fail-closed capacity policy',
      },
    );
  });

  test('readiness marks a held broadcast and pending follow-up as stuck queue risk', async () => {
    const store = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, store);
    const heldSubmission = createDeferred<GaslessExecutionSubmission>();
    let activeBroadcastResolve!: () => void;
    const activeBroadcast = new Promise<void>((resolve) => {
      activeBroadcastResolve = resolve;
    });
    const service = createService(settlementService, store, {
      executeCreateTrade: async () => {
        activeBroadcastResolve();
        return heldSubmission.promise;
      },
    });
    const firstHandoffId = await createHandoff(store, 'c');
    const secondHandoffId = await createHandoff(store, 'd');

    const first = service.executeCreateTrade(buildCreateTradeInput(firstHandoffId, 'c'));
    await activeBroadcast;
    const second = service.executeCreateTrade(buildCreateTradeInput(secondHandoffId, 'd'));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const readiness = service.getRelayerReadiness();
    expect(readiness.queue.active).toBe(1);
    expect(readiness.queue.pending).toBe(1);
    expect(readiness.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'gasless_queue_stuck' })]),
    );

    heldSubmission.resolve(
      buildConfirmedSubmission(
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        '100',
      ),
    );
    await first;
    await second;
  });

  test('failed broadcasts do not poison nonce queue recovery for later submissions', async () => {
    const store = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, store);
    let attempts = 0;
    const service = createService(settlementService, store, {
      executeCreateTrade: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('rpc primary failed during broadcast');
        }

        return buildConfirmedSubmission(
          '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          '100',
        );
      },
    });
    const failedHandoffId = await createHandoff(store, 'e');
    const recoveredHandoffId = await createHandoff(store, 'f');

    await expectGatewayError(
      service.executeCreateTrade(buildCreateTradeInput(failedHandoffId, 'e')),
      {
        statusCode: 502,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless execution failed',
      },
    );
    expect(service.getRelayerReadiness().recentFailureCount).toBe(1);

    const recovered = await service.executeCreateTrade(
      buildCreateTradeInput(recoveredHandoffId, 'f'),
    );

    expect(recovered.txHash).toBe(
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
    expect(service.getRelayerReadiness().recentFailureCount).toBe(0);
  });

  test('shared broadcast lock serializes broadcasts across gateway service instances', async () => {
    const store = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, store);
    const heldSubmission = createDeferred<GaslessExecutionSubmission>();
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });
    let sharedQueue = Promise.resolve();
    const broadcastLock = {
      async runExclusive<T>(handler: () => Promise<T>): Promise<T> {
        const previous = sharedQueue;
        let release!: () => void;
        sharedQueue = new Promise<void>((resolve) => {
          release = resolve;
        });

        await previous;
        try {
          return await handler();
        } finally {
          release();
        }
      },
    };
    const firstService = createService(settlementService, store, {
      executeCreateTrade: async () => {
        firstStartedResolve();
        return heldSubmission.promise;
      },
      options: { broadcastLock },
    });
    let secondStarted = false;
    const secondService = createService(settlementService, store, {
      executeCreateTrade: async () => {
        secondStarted = true;
        return buildConfirmedSubmission(
          '0x1212121212121212121212121212121212121212121212121212121212121212',
          '100',
        );
      },
      options: { broadcastLock },
    });
    const firstHandoffId = await createHandoff(store, 'g');
    const secondHandoffId = await createHandoff(store, 'h');

    const first = firstService.executeCreateTrade(buildCreateTradeInput(firstHandoffId, 'a'));
    await firstStarted;
    const second = secondService.executeCreateTrade(buildCreateTradeInput(secondHandoffId, 'b'));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(secondStarted).toBe(false);

    heldSubmission.resolve(
      buildConfirmedSubmission(
        '0x3434343434343434343434343434343434343434343434343434343434343434',
        '100',
      ),
    );
    await first;
    const secondResult = await second;

    expect(secondStarted).toBe(true);
    expect(secondResult.txHash).toBe(
      '0x1212121212121212121212121212121212121212121212121212121212121212',
    );
  });

  test('managed executor surfaces transient RPC broadcast failure and recovers on next submission', async () => {
    const dependencies = createFakeManagedSignerDependencies({
      broadcastFailures: [new Error('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8545')],
      nonceStart: 50,
    });
    const executor =
      gaslessSettlementExecutionTestExports.createManagedSignerGaslessSettlementExecutor(
        {
          rpcUrl: config.rpcUrl,
          rpcFallbackUrls: config.rpcFallbackUrls,
          chainId: config.chainId,
          escrowAddress: config.escrowAddress,
          gaslessSignerCustodyMode: 'kms',
          gaslessManagedSignerUrl: 'https://signer.example.test',
          gaslessMaxGasLimit: 1_500_000n,
          gaslessMaxFeePerGasWei: 10n,
          gaslessMaxNativeCostWei: 10_000_000n,
          gaslessMinExecutorBalanceWei: 10n,
        },
        dependencies,
      );

    // First broadcast fails with a connection error (not a nonce error),
    // so the executor does not retry internally — it surfaces the failure.
    await expect(
      executor.executeCreateTrade(buildCreateTradeInput('handoff-rpc-fail', '1')),
    ).rejects.toThrow('ECONNREFUSED');

    // The failure consumed the mock error; next call succeeds, proving
    // the executor does not leave poisoned nonce or signer state.
    const recovered = await executor.executeCreateTrade(
      buildCreateTradeInput('handoff-rpc-recover', '2'),
    );
    expect(recovered.txHash).toBe(
      '0x9999999999999999999999999999999999999999999999999999999999999999',
    );
    expect(dependencies.provider.broadcastTransaction).toHaveBeenCalledTimes(2);
  });

  test('readiness reports rpcFallbackCount zero when no fallback URLs are configured', async () => {
    const store = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, store);
    const service = createService(settlementService, store, {
      options: { rpcFallbackCount: 0 },
    });

    const readiness = service.getRelayerReadiness();
    expect(readiness.activeExecutionPath.rpcFallbackCount).toBe(0);
    expect(readiness.state).toBe('ready');
  });

  test('service-level RPC broadcast failure does not block subsequent successful broadcasts', async () => {
    const store = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, store);
    let callCount = 0;
    const service = createService(settlementService, store, {
      executeCreateTrade: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('ECONNREFUSED: primary RPC node down');
        }

        return buildConfirmedSubmission(
          '0xabababababababababababababababababababababababababababababababab',
          '100',
        );
      },
    });
    const failHandoffId = await createHandoff(store, '3');
    const recoverHandoffId = await createHandoff(store, '4');

    // First broadcast fails with a connection error.
    await expectGatewayError(
      service.executeCreateTrade(buildCreateTradeInput(failHandoffId, '3')),
      {
        statusCode: 502,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Gasless execution failed',
      },
    );
    expect(service.getRelayerReadiness().recentFailureCount).toBe(1);

    // Second broadcast succeeds via fallback (simulates FallbackProvider recovery).
    const result = await service.executeCreateTrade(buildCreateTradeInput(recoverHandoffId, '4'));
    expect(result.txHash).toBe(
      '0xabababababababababababababababababababababababababababababababab',
    );
    expect(service.getRelayerReadiness().recentFailureCount).toBe(0);
    expect(service.getRelayerReadiness().state).toBe('ready');
  });
});
