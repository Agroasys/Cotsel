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
  usdcAddress: '0x0000000000000000000000000000000000000888',
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
  test('keeps 64 handoffs, execution events and callback payloads isolated', async () => {
    const activityCount = 64;
    const settlementStore = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, settlementStore);
    const activities = Array.from({ length: activityCount }, (_, index) => ({
      index,
      platformHandoffId: (20_000 + index).toString(),
      tradeId: (900_000 + index).toString(),
      orderId: 10_000 + index,
      orderReference: `ORD-${(10_000 + index).toString().padStart(6, '0')}`,
      supplierPayoutUsd: 600 + index + 0.01,
      treasuryClaimableUsd: 20 + index + 0.02,
      buyerRefundUsd: index + 0.03,
      displayAmount: 620 + index * 3 + 0.06,
      ricardianHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      txHash: `0x${(index + 101).toString(16).padStart(64, '0')}`,
    }));

    const handoffs = await Promise.all(
      activities.map((activity) =>
        settlementService.createHandoff({
          platformId: 'agroasys-platform',
          platformHandoffId: activity.platformHandoffId,
          tradeId: activity.tradeId,
          phase: 'final_release_after_inspection',
          settlementChannel: 'cotsel_escrow',
          displayCurrency: 'USD',
          displayAmount: activity.displayAmount,
          ricardianHash: activity.ricardianHash,
          externalReference: activity.tradeId,
          metadata: {
            orderId: activity.orderId,
            orderReference: activity.orderReference,
            handoffId: Number(activity.platformHandoffId),
            supplierPayoutUsd: activity.supplierPayoutUsd,
            treasuryClaimableUsd: activity.treasuryClaimableUsd,
            buyerRefundUsd: activity.buyerRefundUsd,
          },
          requestId: `req-handoff-capacity-${activity.index}`,
        }),
      ),
    );

    const eventResults = await Promise.all(
      handoffs.map((handoff, index) =>
        settlementService.recordExecutionEvent({
          handoffId: handoff.handoffId,
          eventType: 'submitted',
          executionStatus: 'submitted',
          reconciliationStatus: 'pending',
          providerStatus: `submitted-${index}`,
          txHash: activities[index]!.txHash,
          metadata: {
            orderId: activities[index]!.orderId,
            orderReference: activities[index]!.orderReference,
            handoffId: Number(activities[index]!.platformHandoffId),
            supplierPayoutUsd: activities[index]!.supplierPayoutUsd,
            treasuryClaimableUsd: activities[index]!.treasuryClaimableUsd,
            buyerRefundUsd: activities[index]!.buyerRefundUsd,
            displayAmount: activities[index]!.displayAmount,
          },
          observedAt: new Date(
            Date.parse('2026-07-26T12:00:00.000Z') + index * 1_000,
          ).toISOString(),
          requestId: `req-event-capacity-${index}`,
        }),
      ),
    );

    const retry = await settlementService.recordExecutionEvent({
      handoffId: handoffs[17]!.handoffId,
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      providerStatus: 'submitted-17',
      txHash: activities[17]!.txHash,
      metadata: {
        orderId: activities[17]!.orderId,
        orderReference: activities[17]!.orderReference,
        handoffId: Number(activities[17]!.platformHandoffId),
        supplierPayoutUsd: activities[17]!.supplierPayoutUsd,
        treasuryClaimableUsd: activities[17]!.treasuryClaimableUsd,
        buyerRefundUsd: activities[17]!.buyerRefundUsd,
        displayAmount: activities[17]!.displayAmount,
      },
      observedAt: '2026-07-26T13:17:00.000Z',
      requestId: 'req-event-capacity-17',
    });

    expect(retry.event.eventId).toBe(eventResults[17]!.event.eventId);
    expect(retry.callbackDelivery.deliveryId).toBe(eventResults[17]!.callbackDelivery.deliveryId);

    const listed = await settlementStore.listHandoffs({
      limit: 100,
      offset: 0,
    });
    const deliveries = await settlementStore.getDueCallbackDeliveries(
      100,
      '2100-07-26T14:00:00.000Z',
    );
    expect(listed.total).toBe(activityCount);
    expect(deliveries).toHaveLength(activityCount);
    expect(new Set(handoffs.map((handoff) => handoff.handoffId)).size).toBe(activityCount);
    expect(new Set(deliveries.map((delivery) => delivery.deliveryId)).size).toBe(activityCount);

    for (let index = 0; index < activityCount; index += 1) {
      const activity = activities[index]!;
      const handoff = handoffs[index]!;
      const eventResult = eventResults[index]!;
      const storedHandoff = await settlementStore.getHandoffByPlatformRef(
        'agroasys-platform',
        activity.platformHandoffId,
      );
      const events = await settlementStore.listExecutionEvents(handoff.handoffId);
      const delivery = deliveries.find((candidate) => candidate.handoffId === handoff.handoffId);

      expect(storedHandoff).toMatchObject({
        handoffId: handoff.handoffId,
        platformHandoffId: activity.platformHandoffId,
        tradeId: activity.tradeId,
        displayAmount: activity.displayAmount,
        ricardianHash: activity.ricardianHash,
        externalReference: activity.tradeId,
        txHash: activity.txHash,
        metadata: {
          orderId: activity.orderId,
          orderReference: activity.orderReference,
          handoffId: Number(activity.platformHandoffId),
          supplierPayoutUsd: activity.supplierPayoutUsd,
          treasuryClaimableUsd: activity.treasuryClaimableUsd,
          buyerRefundUsd: activity.buyerRefundUsd,
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventId: eventResult.event.eventId,
        handoffId: handoff.handoffId,
        txHash: activity.txHash,
        metadata: {
          orderId: activity.orderId,
          orderReference: activity.orderReference,
          handoffId: Number(activity.platformHandoffId),
          supplierPayoutUsd: activity.supplierPayoutUsd,
          treasuryClaimableUsd: activity.treasuryClaimableUsd,
          buyerRefundUsd: activity.buyerRefundUsd,
          displayAmount: activity.displayAmount,
        },
      });
      expect(delivery?.requestBody).toMatchObject({
        eventId: eventResult.event.eventId,
        handoffId: handoff.handoffId,
        platformHandoffId: activity.platformHandoffId,
        tradeId: activity.tradeId,
        displayAmount: activity.displayAmount,
        txHash: activity.txHash,
        metadata: {
          orderId: activity.orderId,
          orderReference: activity.orderReference,
          handoffId: Number(activity.platformHandoffId),
          supplierPayoutUsd: activity.supplierPayoutUsd,
          treasuryClaimableUsd: activity.treasuryClaimableUsd,
          buyerRefundUsd: activity.buyerRefundUsd,
          event: {
            orderId: activity.orderId,
            orderReference: activity.orderReference,
            handoffId: Number(activity.platformHandoffId),
            supplierPayoutUsd: activity.supplierPayoutUsd,
            treasuryClaimableUsd: activity.treasuryClaimableUsd,
            buyerRefundUsd: activity.buyerRefundUsd,
            displayAmount: activity.displayAmount,
          },
        },
      });
    }
  });

  test('deduplicates retries of the same execution event and callback outbox record', async () => {
    const settlementStore = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-dedupe',
      tradeId: 'TRD-DEDUPE',
      phase: 'stage_1',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 100,
      requestId: 'req-handoff-dedupe',
    });
    const input = {
      handoffId: handoff.handoffId,
      eventType: 'submitted' as const,
      executionStatus: 'submitted' as const,
      reconciliationStatus: 'pending' as const,
      observedAt: '2026-03-11T11:00:00.000Z',
      requestId: 'req-event-dedupe',
    };

    const first = await settlementService.recordExecutionEvent(input);
    const retry = await settlementService.recordExecutionEvent({
      ...input,
      observedAt: '2026-03-11T11:00:05.000Z',
    });

    expect(retry.event.eventId).toBe(first.event.eventId);
    expect(retry.callbackDelivery.deliveryId).toBe(first.callbackDelivery.deliveryId);
    await expect(settlementStore.listExecutionEvents(handoff.handoffId)).resolves.toHaveLength(1);
    await expect(
      settlementStore.getDueCallbackDeliveries(10, '2100-03-11T11:00:30.000Z'),
    ).resolves.toHaveLength(1);
  });

  test('rolls back the execution transition when callback payload creation fails', async () => {
    const settlementStore = createInMemorySettlementStore();
    const handoff = await settlementStore.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-atomic',
      tradeId: 'TRD-ATOMIC',
      phase: 'stage_1',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 100,
      requestId: 'req-handoff-atomic',
    });

    await expect(
      settlementStore.recordExecutionEvent(
        {
          handoffId: handoff.handoffId,
          eventType: 'submitted',
          executionStatus: 'submitted',
          reconciliationStatus: 'pending',
          observedAt: '2026-03-11T11:30:00.000Z',
          requestId: 'req-event-atomic',
          dedupeKey: 'atomic-dedupe-key',
        },
        {
          targetUrl: config.settlementCallbackUrl!,
          requestId: 'req-event-atomic',
          status: 'pending',
          nextAttemptAt: '2026-03-11T11:30:00.000Z',
          buildRequestBody: () => {
            throw new Error('payload serialization failed');
          },
        },
      ),
    ).rejects.toThrow('payload serialization failed');

    await expect(settlementStore.listExecutionEvents(handoff.handoffId)).resolves.toHaveLength(0);
    await expect(settlementStore.getHandoff(handoff.handoffId)).resolves.toMatchObject({
      executionStatus: 'pending',
      latestEventId: null,
    });
  });

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
