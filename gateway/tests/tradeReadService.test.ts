/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryComplianceStore } from '../src/core/complianceStore';
import { TradeReadService } from '../src/core/tradeReadService';
import { EvidenceLink } from '../src/core/governanceStore';
import { createInMemorySettlementStore } from '../src/core/settlementStore';

const evidenceLinks: EvidenceLink[] = [{ kind: 'ticket', uri: 'https://tickets/agro-1' }];

describe('trade read service', () => {
  const originalFetch = global.fetch;
  const overviewSnapshot = {
    lastIndexedAt: '2026-03-07T10:10:00.000Z',
    lastProcessedBlock: '42042',
    lastTradeEventAt: '2026-03-07T10:00:00.000Z',
  };

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('maps indexer trades into dashboard trade records and compliance status', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T10:12:00.000Z'));
    const complianceStore = createInMemoryComplianceStore([
      {
        decisionId: 'cmp-1',
        tradeId: 'TRD-9001',
        decisionType: 'KYT',
        result: 'DENY',
        reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
        provider: 'chainalysis',
        providerRef: 'case-1',
        subjectId: 'subject-1',
        subjectType: 'counterparty',
        riskLevel: 'high',
        correlationId: 'corr-1',
        decidedAt: '2026-03-07T10:15:00.000Z',
        overrideWindowEndsAt: null,
        blockState: 'blocked',
        audit: {
          reason: 'Provider outage',
          evidenceLinks,
          ticketRef: 'AGRO-1',
          actorSessionId: 'sess-1',
          actorWallet: '0x00000000000000000000000000000000000000aa',
          actorRole: 'admin',
          createdAt: '2026-03-07T10:15:00.000Z',
          requestedBy: 'uid-admin',
        },
      },
    ]);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          overviewSnapshotById: overviewSnapshot,
          trades: [
            {
              tradeId: 'TRD-9001',
              buyer: 'buyer@demo',
              supplier: 'supplier@demo',
              status: 'ARRIVAL_CONFIRMED',
              totalAmountLocked: '125000000000',
              logisticsAmount: '3000000000',
              platformFeesAmount: '1250000000',
              ricardianHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              createdAt: '2026-03-07T09:00:00.000Z',
              arrivalTimestamp: '2026-03-07T10:00:00.000Z',
              events: [
                {
                  eventName: 'TradeLocked',
                  timestamp: '2026-03-07T09:00:00.000Z',
                  txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  totalAmount: '125000000000',
                },
                {
                  eventName: 'ArrivalConfirmed',
                  timestamp: '2026-03-07T10:00:00.000Z',
                  txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                  arrivalTimestamp: '1772877600',
                },
              ],
            },
          ],
        },
      }),
    } as Response);

    const settlementStore = createInMemorySettlementStore([
      {
        handoffId: 'sth-1',
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-1',
        tradeId: 'TRD-9001',
        phase: 'stage_2',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 125000,
        assetSymbol: 'USDC',
        assetAmount: 125000,
        ricardianHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        externalReference: 'EXT-1',
        metadata: { source: 'platform' },
        executionStatus: 'confirmed',
        reconciliationStatus: 'matched',
        callbackStatus: 'delivered',
        providerStatus: 'confirmed',
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        latestEventId: 'evt-1',
        latestEventType: 'reconciled',
        latestEventDetail: 'Settlement confirmed and reconciled.',
        latestEventAt: '2026-03-07T10:05:00.000Z',
        callbackDeliveredAt: '2026-03-07T10:06:00.000Z',
        requestId: 'req-1',
        sourceApiKeyId: 'platform-main',
        createdAt: '2026-03-07T09:00:00.000Z',
        updatedAt: '2026-03-07T10:06:00.000Z',
      },
    ]);

    const service = new TradeReadService(
      'http://127.0.0.1:4350/graphql',
      5000,
      complianceStore,
      settlementStore,
    );
    const snapshot = await service.listTradesSnapshot();
    const records = snapshot.items;

    expect(records).toHaveLength(1);
    expect(snapshot.freshness).toEqual({
      source: 'indexer_graphql',
      state: 'current',
      queriedAt: expect.any(String),
      sourceFreshAt: '2026-03-07T10:10:00.000Z',
      available: true,
      lastProcessedBlock: '42042',
      lastTradeEventAt: '2026-03-07T10:00:00.000Z',
    });
    expect(records[0]).toEqual({
      id: 'TRD-9001',
      buyer: 'buyer@demo',
      supplier: 'supplier@demo',
      amount: 125000,
      currency: 'USDC',
      status: 'stage_2',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      createdAt: '2026-03-07T09:00:00.000Z',
      updatedAt: '2026-03-07T10:00:00.000Z',
      ricardianHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      platformFee: 1250,
      logisticsAmount: 3000,
      complianceStatus: 'fail',
      settlement: {
        handoffId: 'sth-1',
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-1',
        phase: 'stage_2',
        settlementChannel: 'cotsel_escrow',
        displayCurrency: 'USD',
        displayAmount: 125000,
        executionStatus: 'confirmed',
        reconciliationStatus: 'matched',
        callbackStatus: 'delivered',
        providerStatus: 'confirmed',
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        externalReference: 'EXT-1',
        latestEventType: 'reconciled',
        latestEventDetail: 'Settlement confirmed and reconciled.',
        latestEventAt: '2026-03-07T10:05:00.000Z',
        callbackDeliveredAt: '2026-03-07T10:06:00.000Z',
        createdAt: '2026-03-07T09:00:00.000Z',
        updatedAt: '2026-03-07T10:06:00.000Z',
      },
      timeline: [
        {
          stage: 'Lock',
          timestamp: '2026-03-07T09:00:00.000Z',
          actor: 'Buyer',
          txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          detail: 'Escrow locked for 125,000 USDC.',
        },
        {
          stage: 'Arrival Confirmed',
          timestamp: '2026-03-07T10:00:00.000Z',
          actor: 'Oracle',
          txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          detail: 'Arrival confirmed at 2026-03-07T10:00:00.000Z.',
        },
      ],
    });
  });

  test('returns null for missing trade detail and reports upstream errors', async () => {
    const complianceStore = createInMemoryComplianceStore([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { overviewSnapshotById: overviewSnapshot, trades: [] } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { overviewSnapshotById: overviewSnapshot, trades: [] },
          errors: [{ message: 'boom' }],
        }),
      } as Response);

    const service = new TradeReadService('http://127.0.0.1:4350/graphql', 5000, complianceStore);

    await expect(service.getTrade('missing')).resolves.toBeNull();
    await expect(service.listTrades()).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      statusCode: 502,
    });
  });

  test('treats malformed trade arrays as upstream unavailability', async () => {
    const complianceStore = createInMemoryComplianceStore([]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          overviewSnapshotById: overviewSnapshot,
          trades: { tradeId: 'TRD-9001' },
        },
      }),
    } as Response);

    const service = new TradeReadService('http://127.0.0.1:4350/graphql', 5000, complianceStore);

    await expect(service.listTrades()).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      statusCode: 502,
      message: 'Indexer returned an invalid GraphQL payload',
    });
  });

  test('treats invalid arrival timestamps as upstream unavailability', async () => {
    const complianceStore = createInMemoryComplianceStore([]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          overviewSnapshotById: overviewSnapshot,
          trades: [
            {
              tradeId: 'TRD-9002',
              buyer: 'buyer@demo',
              supplier: 'supplier@demo',
              status: 'ARRIVAL_CONFIRMED',
              totalAmountLocked: '125000000000',
              logisticsAmount: '3000000000',
              platformFeesAmount: '1250000000',
              ricardianHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              createdAt: '2026-03-07T09:00:00.000Z',
              events: [
                {
                  eventName: 'ArrivalConfirmed',
                  timestamp: '2026-03-07T10:00:00.000Z',
                  txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                  arrivalTimestamp: 'invalid-seconds',
                },
              ],
            },
          ],
        },
      }),
    } as Response);

    const service = new TradeReadService('http://127.0.0.1:4350/graphql', 5000, complianceStore);

    await expect(service.listTrades()).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      statusCode: 502,
      message: 'Indexer returned invalid event.arrivalTimestamp timestamp',
    });
  });

  test('fails readiness when the indexer readiness payload is malformed', async () => {
    const complianceStore = createInMemoryComplianceStore([]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          overviewSnapshotById: overviewSnapshot,
          trades: { tradeId: 'TRD-9003' },
        },
      }),
    } as Response);

    const service = new TradeReadService('http://127.0.0.1:4350/graphql', 5000, complianceStore);

    await expect(service.checkReadiness()).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      statusCode: 502,
      message: 'Indexer returned an invalid GraphQL payload',
    });
  });
});
