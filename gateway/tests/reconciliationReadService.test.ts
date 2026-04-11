/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ReconciliationReadService } from '../src/core/reconciliationReadService';
import { createInMemorySettlementStore } from '../src/core/settlementStore';

describe('reconciliation read service', () => {
  test('lists reconciliation summaries with trade projections and pagination metadata', async () => {
    const store = createInMemorySettlementStore([
      {
        handoffId: 'sth-2',
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-2',
        tradeId: 'TRD-9002',
        phase: 'stage_2',
        settlementChannel: 'web3layer_escrow',
        displayCurrency: 'USD',
        displayAmount: 9000,
        assetSymbol: 'USDC',
        assetAmount: 9000,
        ricardianHash: null,
        externalReference: 'EXT-2',
        metadata: {},
        executionStatus: 'confirmed',
        reconciliationStatus: 'matched',
        callbackStatus: 'delivered',
        providerStatus: 'confirmed',
        txHash: '0x2',
        latestEventId: 'evt-2',
        latestEventType: 'reconciled',
        latestEventDetail: 'Matched',
        latestEventAt: '2026-03-14T10:05:00.000Z',
        callbackDeliveredAt: '2026-03-14T10:06:00.000Z',
        requestId: 'req-2',
        sourceApiKeyId: 'platform-main',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:06:00.000Z',
      },
      {
        handoffId: 'sth-1',
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-1',
        tradeId: 'TRD-9001',
        phase: 'stage_1',
        settlementChannel: 'web3layer_escrow',
        displayCurrency: 'USD',
        displayAmount: 5000,
        assetSymbol: 'USDC',
        assetAmount: 5000,
        ricardianHash: null,
        externalReference: 'EXT-1',
        metadata: {},
        executionStatus: 'submitted',
        reconciliationStatus: 'drift',
        callbackStatus: 'failed',
        providerStatus: 'dispatch_received',
        txHash: '0x1',
        latestEventId: 'evt-1',
        latestEventType: 'drift_detected',
        latestEventDetail: 'Mismatch detected',
        latestEventAt: '2026-03-14T09:05:00.000Z',
        callbackDeliveredAt: null,
        requestId: 'req-1',
        sourceApiKeyId: 'platform-main',
        createdAt: '2026-03-14T09:00:00.000Z',
        updatedAt: '2026-03-14T09:05:00.000Z',
      },
    ]);

    const service = new ReconciliationReadService(
      store,
      () => new Date('2026-03-14T11:00:00.000Z'),
    );
    const snapshot = await service.listReconciliation({
      reconciliationStatus: 'matched',
      limit: 10,
      offset: 0,
    });

    expect(snapshot.pagination).toEqual({ limit: 10, offset: 0, total: 1 });
    expect(snapshot.freshness).toEqual({
      source: 'gateway_settlement_ledger',
      sourceFreshAt: '2026-03-14T10:06:00.000Z',
      queriedAt: '2026-03-14T11:00:00.000Z',
      available: true,
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.handoffId).toBe('sth-2');
    expect(snapshot.items[0]?.tradeProjection?.handoffId).toBe('sth-2');
  });

  test('returns a degraded snapshot when the settlement store is unavailable', async () => {
    const store = {
      listHandoffs: jest.fn().mockRejectedValue(new Error('connection refused')),
      getTradeSettlementProjectionMap: jest.fn(),
      getHandoff: jest.fn(),
      getHandoffByPlatformRef: jest.fn(),
      createHandoff: jest.fn(),
      createExecutionEvent: jest.fn(),
      listExecutionEvents: jest.fn(),
      queueCallbackDelivery: jest.fn(),
      getCallbackDelivery: jest.fn(),
      getDueCallbackDeliveries: jest.fn(),
      markCallbackDelivering: jest.fn(),
      markCallbackDelivered: jest.fn(),
      markCallbackFailed: jest.fn(),
      requeueCallbackDelivery: jest.fn(),
    };

    const service = new ReconciliationReadService(
      store,
      () => new Date('2026-03-14T11:00:00.000Z'),
    );
    const snapshot = await service.listReconciliation({
      limit: 25,
      offset: 0,
    });

    expect(snapshot).toEqual({
      items: [],
      pagination: { limit: 25, offset: 0, total: 0 },
      freshness: {
        source: 'gateway_settlement_ledger',
        sourceFreshAt: null,
        queriedAt: '2026-03-14T11:00:00.000Z',
        available: false,
        degradedReason: 'connection refused',
      },
    });
  });

  test('preserves handoff rows when projection lookups degrade', async () => {
    const store = {
      listHandoffs: jest.fn().mockResolvedValue({
        items: [
          {
            handoffId: 'sth-2',
            platformId: 'agroasys-platform',
            platformHandoffId: 'handoff-2',
            tradeId: 'TRD-9002',
            phase: 'stage_2',
            settlementChannel: 'web3layer_escrow',
            displayCurrency: 'USD',
            displayAmount: 9000,
            assetSymbol: 'USDC',
            assetAmount: 9000,
            ricardianHash: null,
            externalReference: 'EXT-2',
            metadata: {},
            executionStatus: 'confirmed',
            reconciliationStatus: 'matched',
            callbackStatus: 'delivered',
            providerStatus: 'confirmed',
            txHash: '0x2',
            latestEventId: 'evt-2',
            latestEventType: 'reconciled',
            latestEventDetail: 'Matched',
            latestEventAt: '2026-03-14T10:05:00.000Z',
            callbackDeliveredAt: '2026-03-14T10:06:00.000Z',
            requestId: 'req-2',
            sourceApiKeyId: 'platform-main',
            createdAt: '2026-03-14T10:00:00.000Z',
            updatedAt: '2026-03-14T10:06:00.000Z',
          },
        ],
        total: 1,
        sourceFreshAt: '2026-03-14T10:06:00.000Z',
      }),
      getTradeSettlementProjectionMap: jest
        .fn()
        .mockRejectedValue(new Error('projection lookup unavailable')),
      getHandoff: jest.fn(),
      getHandoffByPlatformRef: jest.fn(),
      createHandoff: jest.fn(),
      createExecutionEvent: jest.fn(),
      listExecutionEvents: jest.fn(),
      queueCallbackDelivery: jest.fn(),
      getCallbackDelivery: jest.fn(),
      getDueCallbackDeliveries: jest.fn(),
      markCallbackDelivering: jest.fn(),
      markCallbackDelivered: jest.fn(),
      markCallbackFailed: jest.fn(),
      requeueCallbackDelivery: jest.fn(),
    };

    const service = new ReconciliationReadService(
      store as never,
      () => new Date('2026-03-14T11:00:00.000Z'),
    );
    const snapshot = await service.listReconciliation({
      limit: 25,
      offset: 0,
    });

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.handoffId).toBe('sth-2');
    expect(snapshot.items[0]?.tradeProjection).toBeNull();
    expect(snapshot.freshness.available).toBe(false);
    expect(snapshot.freshness.degradedReason).toContain('projection lookup unavailable');
  });
});
