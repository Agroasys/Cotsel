/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { SettlementCallbackDispatcher } from '../src/core/settlementCallbackDispatcher';
import { SettlementService } from '../src/core/settlementService';
import { createInMemorySettlementStore } from '../src/core/settlementStore';
import { baseTestGatewayConfig } from './support/testConfig';

const config = {
  ...baseTestGatewayConfig,
  settlementCallbackEnabled: true,
  settlementCallbackUrl: 'https://platform.example.com/internal/settlement-events',
  settlementCallbackApiKey: 'callback-key',
  settlementCallbackApiSecret: 'callback-secret',
  settlementCallbackMaxAttempts: 3,
  settlementCallbackInitialBackoffMs: 1000,
  settlementCallbackMaxBackoffMs: 4000,
};

describe('settlement callback delivery leases', () => {
  test('reclaims an expired lease and preserves the stable event identity', async () => {
    const settlementStore = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-expired-lease',
      tradeId: 'TRD-EXPIRED-LEASE',
      phase: 'stage_2',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 250,
      requestId: 'req-handoff-expired-lease',
    });

    await settlementService.recordExecutionEvent({
      handoffId: handoff.handoffId,
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      providerStatus: 'dispatch_received',
      observedAt: '2026-03-11T12:15:00.000Z',
      requestId: 'req-event-expired-lease',
    });

    const originalDelivery = (
      await settlementStore.getDueCallbackDeliveries(1, '2100-03-11T12:15:01.000Z')
    )[0];
    expect(originalDelivery).toBeDefined();

    const crashedWorkerClaim = await settlementStore.markCallbackDelivering(
      originalDelivery!.deliveryId,
      'worker-that-crashed',
      '2100-03-11T12:15:01.000Z',
      '2100-03-11T12:15:31.000Z',
    );
    expect(crashedWorkerClaim).toMatchObject({
      attemptCount: 1,
      leaseOwner: 'worker-that-crashed',
      status: 'delivering',
    });
    await expect(
      settlementStore.getDueCallbackDeliveries(1, '2100-03-11T12:15:30.999Z'),
    ).resolves.toHaveLength(0);

    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const replacementDispatcher = new SettlementCallbackDispatcher(config, settlementStore, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date('2100-03-11T12:15:31.000Z'),
      workerId: 'replacement-worker',
    });
    await replacementDispatcher.processDueDeliveries();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      eventId: originalDelivery!.eventId,
    });
    await expect(
      settlementStore.getCallbackDelivery(originalDelivery!.deliveryId),
    ).resolves.toMatchObject({
      attemptCount: 2,
      deliveredAt: '2100-03-11T12:15:31.000Z',
      leaseExpiresAt: null,
      leaseOwner: null,
      status: 'delivered',
    });
  });

  test('prevents a stale worker from committing after lease replacement', async () => {
    const settlementStore = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-stale-worker',
      tradeId: 'TRD-STALE-WORKER',
      phase: 'stage_2',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 300,
      requestId: 'req-handoff-stale-worker',
    });
    await settlementService.recordExecutionEvent({
      handoffId: handoff.handoffId,
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      providerStatus: 'dispatch_received',
      observedAt: '2026-03-11T12:17:00.000Z',
      requestId: 'req-event-stale-worker',
    });
    const delivery = (
      await settlementStore.getDueCallbackDeliveries(1, '2100-03-11T12:17:01.000Z')
    )[0]!;

    await settlementStore.markCallbackDelivering(
      delivery.deliveryId,
      'stale-worker',
      '2100-03-11T12:17:01.000Z',
      '2100-03-11T12:17:31.000Z',
    );
    await settlementStore.markCallbackDelivering(
      delivery.deliveryId,
      'current-worker',
      '2100-03-11T12:17:31.000Z',
      '2100-03-11T12:18:01.000Z',
    );

    await expect(
      settlementStore.markCallbackDelivered(
        delivery.deliveryId,
        'stale-worker',
        '2100-03-11T12:17:32.000Z',
        202,
      ),
    ).resolves.toBe(false);
    await expect(
      settlementStore.markCallbackFailed(delivery.deliveryId, 'stale-worker', {
        attemptedAt: '2100-03-11T12:17:32.000Z',
        responseStatus: 500,
        errorMessage: 'late stale-worker result',
        nextAttemptAt: '2100-03-11T12:18:32.000Z',
        deadLetter: false,
      }),
    ).resolves.toBe(false);
    await expect(
      settlementStore.markCallbackDelivered(
        delivery.deliveryId,
        'current-worker',
        '2100-03-11T12:17:33.000Z',
        202,
      ),
    ).resolves.toBe(true);
  });

  test('does not let an older event callback overwrite the latest handoff state', async () => {
    const settlementStore = createInMemorySettlementStore();
    const settlementService = new SettlementService(config, settlementStore);
    const handoff = await settlementService.createHandoff({
      platformId: 'agroasys-platform',
      platformHandoffId: 'handoff-stale-event',
      tradeId: 'TRD-STALE-EVENT',
      phase: 'stage_2',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 700,
      requestId: 'req-handoff-stale-event',
    });

    await settlementService.recordExecutionEvent({
      handoffId: handoff.handoffId,
      eventType: 'submitted',
      executionStatus: 'submitted',
      reconciliationStatus: 'pending',
      providerStatus: 'dispatch_received',
      observedAt: '2026-03-11T12:20:00.000Z',
      requestId: 'req-event-stale-event-a',
    });
    const olderDelivery = (
      await settlementStore.getDueCallbackDeliveries(10, '2100-03-11T12:20:10.000Z')
    )[0]!;

    await settlementService.recordExecutionEvent({
      handoffId: handoff.handoffId,
      eventType: 'confirmed',
      executionStatus: 'confirmed',
      reconciliationStatus: 'pending',
      providerStatus: 'confirmed',
      observedAt: '2026-03-11T12:20:05.000Z',
      requestId: 'req-event-stale-event-b',
    });
    await settlementStore.markCallbackDelivering(
      olderDelivery.deliveryId,
      'older-event-worker',
      '2100-03-11T12:20:10.000Z',
      '2100-03-11T12:20:40.000Z',
    );
    await settlementStore.markCallbackFailed(olderDelivery.deliveryId, 'older-event-worker', {
      attemptedAt: '2100-03-11T12:20:11.000Z',
      responseStatus: 500,
      errorMessage: 'older event callback failed',
      nextAttemptAt: '2100-03-11T12:20:30.000Z',
      deadLetter: false,
    });

    await expect(settlementStore.getHandoff(handoff.handoffId)).resolves.toMatchObject({
      callbackStatus: 'pending',
      latestEventType: 'confirmed',
    });
  });
});
