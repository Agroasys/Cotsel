/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GatewayConfig } from '../src/config/env';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { GatewayErrorHandlerWorkflow } from '../src/core/errorHandlerWorkflow';
import { createInMemoryFailedOperationStore } from '../src/core/failedOperationStore';
import { SettlementCallbackDispatcher } from '../src/core/settlementCallbackDispatcher';
import { SettlementService } from '../src/core/settlementService';
import { createInMemorySettlementStore } from '../src/core/settlementStore';

const config: GatewayConfig = {
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
  escrowAddress: '0x0000000000000000000000000000000000000000',
  enableMutations: false,
  writeAllowlist: [],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: false,
  settlementServiceAuthApiKeysJson: '[]',
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: true,
  settlementCallbackUrl: 'https://platform.example.com/internal/settlement-events',
  settlementCallbackApiKey: 'callback-key',
  settlementCallbackApiSecret: 'callback-secret',
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 3,
  settlementCallbackInitialBackoffMs: 1000,
  settlementCallbackMaxBackoffMs: 4000,
  commitSha: 'abc1234',
  buildTime: '2026-03-11T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

describe('settlement callback dispatcher', () => {
  test('delivers queued callbacks and marks the handoff callback state as delivered', async () => {
    const settlementStore = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-1',
      tradeId: 'TRD-1',
      phase: 'stage_1',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 1000,
      requestId: 'req-handoff',
    });

    await settlementService.recordExecutionEvent({
      handoffId: handoff.handoffId,
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      providerStatus: 'dispatch_received',
      observedAt: '2026-03-11T12:00:00.000Z',
      requestId: 'req-event',
    });

    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const dispatcher = new SettlementCallbackDispatcher(config, settlementStore, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date('2100-03-11T12:00:30.000Z'),
    });

    await dispatcher.processDueDeliveries();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const updatedHandoff = await settlementStore.getHandoff(handoff.handoffId);
    expect(updatedHandoff?.callbackStatus).toBe('delivered');
  });

  test('retries failed callbacks and dead-letters after the max attempts threshold', async () => {
    const settlementStore = createInMemorySettlementStore();
    const failedOperationStore = createInMemoryFailedOperationStore();
    const workflow = new GatewayErrorHandlerWorkflow(
      failedOperationStore,
      createInMemoryAuditLogStore(),
    );
    const settlementService = new SettlementService(config, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-2',
      tradeId: 'TRD-2',
      phase: 'stage_2',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 500,
      requestId: 'req-handoff-2',
    });

    await settlementService.recordExecutionEvent({
      handoffId: handoff.handoffId,
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      providerStatus: 'dispatch_received',
      observedAt: '2026-03-11T12:10:00.000Z',
      requestId: 'req-event-2',
    });

    let now = new Date('2100-03-11T12:10:01.000Z');
    const fetchMock = jest.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const dispatcher = new SettlementCallbackDispatcher(config, settlementStore, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => now,
      failedOperationWorkflow: workflow,
    });

    await dispatcher.processDueDeliveries();
    let updatedHandoff = await settlementStore.getHandoff(handoff.handoffId);
    expect(updatedHandoff?.callbackStatus).toBe('failed');

    now = new Date('2100-03-11T12:10:03.000Z');
    await dispatcher.processDueDeliveries();
    updatedHandoff = await settlementStore.getHandoff(handoff.handoffId);
    expect(updatedHandoff?.callbackStatus).toBe('failed');

    now = new Date('2100-03-11T12:10:07.000Z');
    await dispatcher.processDueDeliveries();
    updatedHandoff = await settlementStore.getHandoff(handoff.handoffId);
    expect(updatedHandoff?.callbackStatus).toBe('dead_letter');
    const failedOperations = await failedOperationStore.list();
    expect(failedOperations).toHaveLength(1);
    expect(failedOperations[0]).toMatchObject({
      operationType: 'settlement.callback_delivery',
      failureState: 'open',
      replayEligible: true,
      targetService: 'settlement_callback',
    });
  });

  test('stale callback deliveries do not overwrite the latest handoff callback status', async () => {
    const settlementStore = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-3',
      tradeId: 'TRD-3',
      phase: 'stage_2',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 700,
      requestId: 'req-handoff-3',
    });

    await settlementService.recordExecutionEvent({
      handoffId: handoff.handoffId,
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      providerStatus: 'dispatch_received',
      observedAt: '2026-03-11T12:20:00.000Z',
      requestId: 'req-event-3a',
    });

    const originalDelivery = (
      await settlementStore.getDueCallbackDeliveries(10, '2100-03-11T12:20:10.000Z')
    )[0];
    expect(originalDelivery).toBeDefined();

    await settlementService.recordExecutionEvent({
      handoffId: handoff.handoffId,
      eventType: 'confirmed',
      executionStatus: 'confirmed',
      reconciliationStatus: 'pending',
      providerStatus: 'confirmed',
      observedAt: '2026-03-11T12:20:05.000Z',
      requestId: 'req-event-3b',
    });

    await settlementStore.markCallbackFailed(originalDelivery!.deliveryId, {
      attemptedAt: '2100-03-11T12:20:11.000Z',
      responseStatus: 500,
      errorMessage: 'stale callback failed',
      nextAttemptAt: '2100-03-11T12:20:30.000Z',
      deadLetter: false,
    });

    const updatedHandoff = await settlementStore.getHandoff(handoff.handoffId);
    expect(updatedHandoff?.callbackStatus).toBe('pending');
    expect(updatedHandoff?.latestEventType).toBe('confirmed');
  });
});
