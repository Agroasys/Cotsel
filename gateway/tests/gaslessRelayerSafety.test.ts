import { executionBindingFixture } from './helpers/settlementExecutionBindingFixtures';
import {
  createGaslessExecutionScopeHash,
  createGaslessPayloadHash,
} from '../src/core/gaslessRequestNormalization';
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type GaslessCreateTradeExecutionInput,
  type GaslessExecutionSubmission,
  createEthersGaslessSettlementExecutor,
  GaslessSettlementExecutionService,
} from '../src/core/gaslessSettlementExecutionService';
import { SettlementService } from '../src/core/settlementService';
import { createInMemorySettlementStore, type SettlementStore } from '../src/core/settlementStore';
import { buildCreateTradeInput, config } from './helpers/gaslessManagedSignerFixtures';

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

const boundInputs = new Map<string, GaslessCreateTradeExecutionInput>();

async function createHandoff(store: SettlementStore, label: string): Promise<string> {
  const boundInput = {
    ...buildCreateTradeInput('pending', /^[a-f0-9]/.test(label) ? label : 'a'),
    sourceApiKeyId: 'service-test',
  };
  const handoff = await store.createHandoff({
    sourceApiKeyId: 'service-test',
    executionBinding: executionBindingFixture(boundInput, 'service-test', config.usdcAddress),
    externalReference: 'controlled-operation',
    ricardianHash: boundInput.ricardianHash,
    metadata: {
      executionScopeVersion: 'gasless_create_trade_scope_v1',
      executionScopeHash: createGaslessExecutionScopeHash(boundInput),
    },
    platformId: 'agroasys-platform',
    platformHandoffId: `handoff-${label}`,
    tradeId: `TRD-${label}`,
    phase: 'gasless_create_trade',
    settlementChannel: 'cotsel_escrow',
    displayCurrency: 'USD',
    displayAmount: 1000,
    assetSymbol: 'USDC',
    assetAmount: 1000,
    requestId: `request-${label}`,
  });

  const {
    requestId: _requestId,
    sourceApiKeyId: _sourceApiKeyId,
    payloadHash: _payloadHash,
    ...payload
  } = boundInput;
  boundInputs.set(handoff.handoffId, {
    ...boundInput,
    handoffId: handoff.handoffId,
    payloadHash: createGaslessPayloadHash({ ...payload, handoffId: handoff.handoffId }),
  });
  return handoff.handoffId;
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
    usdcAddress: config.usdcAddress,
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
      executeUserAction: async () => {
        throw new Error('Unexpected guarded user-action execution');
      },
      simulateWalletUsdcTransfer: async () => ({ gasEstimate: 110000n }),
      executeWalletUsdcTransfer: async () =>
        buildConfirmedSubmission(
          '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          '100',
        ),
    },
    {
      ...defaultOptions,
      ...(overrides.options ?? {}),
    },
  );
}

describe('gasless relayer safety controls', () => {
  test('paused relayer rejects broadcasts before queueing execution', async () => {
    const store = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, store);
    const service = createService(settlementService, store, {
      options: { broadcastPaused: true },
    });
    const handoffId = await createHandoff(store, 'a');

    await expectGatewayError(service.executeCreateTrade(boundInputs.get(handoffId)!), {
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Gasless relayer broadcast is paused',
    });

    expect(service.getRelayerReadiness().state).toBe('paused');
    expect(service.getRelayerReadiness().queue.pending).toBe(0);
    expect(service.getRelayerReadiness().queue.active).toBe(0);
  });

  test('gateway refuses KMS custody without the isolated relayer transport', () => {
    expect(() =>
      createEthersGaslessSettlementExecutor({
        rpcUrl: config.rpcUrl,
        rpcFallbackUrls: config.rpcFallbackUrls,
        chainId: config.chainId,
        escrowAddress: config.escrowAddress,
        usdcAddress: config.usdcAddress,
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

    await service.executeCreateTrade(boundInputs.get(firstHandoffId)!);
    expect(service.getRelayerReadiness().state).toBe('blocked');

    await expectGatewayError(service.executeCreateTrade(boundInputs.get(secondHandoffId)!), {
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Gasless executor balance is below fail-closed capacity policy',
    });
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

    const first = service.executeCreateTrade(boundInputs.get(firstHandoffId)!);
    await activeBroadcast;
    const second = service.executeCreateTrade(boundInputs.get(secondHandoffId)!);
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

    await expectGatewayError(service.executeCreateTrade(boundInputs.get(failedHandoffId)!), {
      statusCode: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Gasless execution failed',
    });
    expect(service.getRelayerReadiness().recentFailureCount).toBe(1);

    const recovered = await service.executeCreateTrade(boundInputs.get(recoveredHandoffId)!);

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

    const first = firstService.executeCreateTrade(boundInputs.get(firstHandoffId)!);
    await firstStarted;
    const second = secondService.executeCreateTrade(boundInputs.get(secondHandoffId)!);
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
    await expectGatewayError(service.executeCreateTrade(boundInputs.get(failHandoffId)!), {
      statusCode: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Gasless execution failed',
    });
    expect(service.getRelayerReadiness().recentFailureCount).toBe(1);

    // Second broadcast succeeds via fallback (simulates FallbackProvider recovery).
    const result = await service.executeCreateTrade(boundInputs.get(recoverHandoffId)!);
    expect(result.txHash).toBe(
      '0xabababababababababababababababababababababababababababababababab',
    );
    expect(service.getRelayerReadiness().recentFailureCount).toBe(0);
    expect(service.getRelayerReadiness().state).toBe('ready');
  });
});
