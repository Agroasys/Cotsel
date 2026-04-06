/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ComplianceStore } from '../src/core/complianceStore';
import {
  buildGovernanceIntentKey,
  createInMemoryGovernanceActionStore,
  type GovernanceActionRecord,
} from '../src/core/governanceStore';
import { EvidenceReadService } from '../src/core/evidenceReadService';
import type { RicardianClient } from '../src/core/ricardianClient';
import { createInMemorySettlementStore } from '../src/core/settlementStore';
import type { TradeReadReader } from '../src/core/tradeReadService';

const tradeFixture = {
  id: 'TRD-9001',
  buyer: 'buyer@demo',
  supplier: 'supplier@demo',
  amount: 125000,
  currency: 'USDC' as const,
  status: 'stage_2' as const,
  txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  createdAt: '2026-03-14T09:00:00.000Z',
  updatedAt: '2026-03-14T10:00:00.000Z',
  ricardianHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  platformFee: 1250,
  logisticsAmount: 3000,
  complianceStatus: 'pass' as const,
  settlement: {
    handoffId: 'sth-1',
    platformId: 'agroasys-platform',
    platformHandoffId: 'handoff-1',
    phase: 'stage_2',
    settlementChannel: 'web3layer_escrow',
    displayCurrency: 'USD',
    displayAmount: 125000,
    executionStatus: 'confirmed' as const,
    reconciliationStatus: 'matched' as const,
    callbackStatus: 'delivered' as const,
    providerStatus: 'confirmed',
    txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    extrinsicHash: null,
    externalReference: 'EXT-1',
    latestEventType: 'reconciled' as const,
    latestEventDetail: 'Settlement confirmed and reconciled.',
    latestEventAt: '2026-03-14T10:05:00.000Z',
    callbackDeliveredAt: '2026-03-14T10:06:00.000Z',
    createdAt: '2026-03-14T09:00:00.000Z',
    updatedAt: '2026-03-14T10:06:00.000Z',
  },
  timeline: [],
};

const governanceFixture: GovernanceActionRecord[] = [
  {
    actionId: 'gov-1',
    intentKey: buildGovernanceIntentKey({
      category: 'pause',
      contractMethod: 'pause',
      tradeId: 'TRD-9001',
      chainId: '31337',
    }),
    proposalId: null,
    category: 'pause',
    status: 'executed',
    contractMethod: 'pause',
    txHash: '0xabc',
    extrinsicHash: null,
    blockNumber: 17,
    tradeId: 'TRD-9001',
    chainId: '31337',
    targetAddress: null,
    createdAt: '2026-03-14T10:00:00.000Z',
    expiresAt: '2026-03-15T10:00:00.000Z',
    executedAt: '2026-03-14T10:01:00.000Z',
    requestId: 'req-1',
    correlationId: 'corr-1',
    errorCode: null,
    errorMessage: null,
    flowType: 'executor',
    broadcastAt: null,
    audit: {
      reason: 'Pause trade.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/agro-1' }],
      ticketRef: 'AGRO-1',
      actorSessionId: 'sess-1',
      actorWallet: '0x00000000000000000000000000000000000000a1',
      actorRole: 'admin',
      createdAt: '2026-03-14T10:00:00.000Z',
      requestedBy: 'uid-admin-1',
    },
  },
];

describe('evidence read service', () => {
  test('returns a verified ricardian payload when the document and settlement hashes match', async () => {
    const tradeReadService: TradeReadReader = {
      checkReadiness: jest.fn(),
      listTrades: jest.fn(),
      getTrade: jest.fn().mockResolvedValue(tradeFixture),
    };

    const settlementStore = createInMemorySettlementStore([
      {
        handoffId: 'sth-1',
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-1',
        tradeId: 'TRD-9001',
        phase: 'stage_2',
        settlementChannel: 'web3layer_escrow',
        displayCurrency: 'USD',
        displayAmount: 125000,
        assetSymbol: 'USDC',
        assetAmount: 125000,
        ricardianHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        externalReference: 'EXT-1',
        metadata: {},
        executionStatus: 'confirmed',
        reconciliationStatus: 'matched',
        callbackStatus: 'delivered',
        providerStatus: 'confirmed',
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        extrinsicHash: null,
        latestEventId: 'evt-1',
        latestEventType: 'reconciled',
        latestEventDetail: 'Settlement confirmed and reconciled.',
        latestEventAt: '2026-03-14T10:05:00.000Z',
        callbackDeliveredAt: '2026-03-14T10:06:00.000Z',
        requestId: 'req-1',
        sourceApiKeyId: 'platform-main',
        createdAt: '2026-03-14T09:00:00.000Z',
        updatedAt: '2026-03-14T10:06:00.000Z',
      },
    ]);

    const ricardianClient = {
      getDocument: jest.fn().mockResolvedValue({
        id: 'doc-1',
        requestId: 'req-doc-1',
        documentRef: 'CTSL-TRD-9001',
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rulesVersion: 'v1',
        canonicalJson: { tradeId: 'TRD-9001' },
        metadata: { issuer: 'ctsp' },
        createdAt: '2026-03-14T09:30:00.000Z',
      }),
    } as unknown as RicardianClient;

    const complianceStore = {
      listTradeDecisions: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    } as unknown as ComplianceStore;

    const service = new EvidenceReadService(
      tradeReadService,
      settlementStore,
      ricardianClient,
      complianceStore,
      createInMemoryGovernanceActionStore(governanceFixture),
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const result = await service.getRicardianDocument('TRD-9001');

    expect(result).toEqual({
      tradeId: 'TRD-9001',
      ricardianHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      document: {
        id: 'doc-1',
        requestId: 'req-doc-1',
        documentRef: 'CTSL-TRD-9001',
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rulesVersion: 'v1',
        canonicalJson: { tradeId: 'TRD-9001' },
        metadata: { issuer: 'ctsp' },
        createdAt: '2026-03-14T09:30:00.000Z',
      },
      verification: {
        status: 'verified',
        tradeHashMatchesDocument: true,
        settlementHashMatchesTrade: true,
      },
      freshness: {
        source: 'ricardian_http',
        sourceFreshAt: '2026-03-14T09:30:00.000Z',
        queriedAt: '2026-03-14T11:00:00.000Z',
        available: true,
      },
    });
  });

  test('returns grouped evidence records for a trade', async () => {
    const tradeReadService: TradeReadReader = {
      checkReadiness: jest.fn(),
      listTrades: jest.fn(),
      getTrade: jest.fn().mockResolvedValue(tradeFixture),
    };

    const settlementStore = createInMemorySettlementStore();
    const ricardianClient = { getDocument: jest.fn() } as unknown as RicardianClient;
    const complianceStore = {
      listTradeDecisions: jest.fn().mockResolvedValue({
        items: [
          {
            decisionId: 'cmp-1',
            tradeId: 'TRD-9001',
            decisionType: 'KYT',
            result: 'ALLOW',
            reasonCode: 'OK',
            provider: 'chainalysis',
            providerRef: 'case-1',
            subjectId: 'subject-1',
            subjectType: 'counterparty',
            riskLevel: 'low',
            correlationId: 'corr-1',
            decidedAt: '2026-03-14T09:45:00.000Z',
            overrideWindowEndsAt: null,
            blockState: 'not_blocked',
            audit: {
              reason: 'Approved',
              evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/agro-2' }],
              ticketRef: 'AGRO-2',
              actorSessionId: 'sess-2',
              actorWallet: '0x00000000000000000000000000000000000000b2',
              actorRole: 'admin',
              createdAt: '2026-03-14T09:45:00.000Z',
              requestedBy: 'uid-admin-2',
            },
          },
        ],
        nextCursor: null,
      }),
    } as unknown as ComplianceStore;

    const service = new EvidenceReadService(
      tradeReadService,
      settlementStore,
      ricardianClient,
      complianceStore,
      createInMemoryGovernanceActionStore(governanceFixture),
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const result = await service.getTradeEvidence('TRD-9001');

    expect(result.tradeId).toBe('TRD-9001');
    expect(result.settlement?.handoffId).toBe('sth-1');
    expect(result.complianceDecisions).toHaveLength(1);
    expect(result.governanceActions).toHaveLength(1);
    expect(result.freshness).toEqual({
      source: 'gateway_ledgers',
      sourceFreshAt: '2026-03-14T10:06:00.000Z',
      queriedAt: '2026-03-14T11:00:00.000Z',
      available: true,
    });
  });

  test('degrades ricardian verification when the settlement handoff lookup fails', async () => {
    const tradeReadService: TradeReadReader = {
      checkReadiness: jest.fn(),
      listTrades: jest.fn(),
      getTrade: jest.fn().mockResolvedValue(tradeFixture),
    };

    const settlementStore = {
      getHandoff: jest.fn().mockRejectedValue(new Error('settlement ledger unavailable')),
    } as unknown as ReturnType<typeof createInMemorySettlementStore>;

    const ricardianClient = {
      getDocument: jest.fn().mockResolvedValue({
        id: 'doc-1',
        requestId: 'req-doc-1',
        documentRef: 'CTSL-TRD-9001',
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rulesVersion: 'v1',
        canonicalJson: { tradeId: 'TRD-9001' },
        metadata: { issuer: 'ctsp' },
        createdAt: '2026-03-14T09:30:00.000Z',
      }),
    } as unknown as RicardianClient;

    const complianceStore = {
      listTradeDecisions: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    } as unknown as ComplianceStore;

    const service = new EvidenceReadService(
      tradeReadService,
      settlementStore,
      ricardianClient,
      complianceStore,
      createInMemoryGovernanceActionStore(governanceFixture),
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const result = await service.getRicardianDocument('TRD-9001');

    expect(result.verification.status).toBe('unavailable');
    expect(result.verification.tradeHashMatchesDocument).toBe(true);
    expect(result.verification.settlementHashMatchesTrade).toBeNull();
    expect(result.freshness.available).toBe(false);
    expect(result.freshness.degradedReason).toContain('settlement ledger unavailable');
  });

  test('does not report a synthetic ricardian mismatch when the upstream document service is unavailable', async () => {
    const tradeReadService: TradeReadReader = {
      checkReadiness: jest.fn(),
      listTrades: jest.fn(),
      getTrade: jest.fn().mockResolvedValue(tradeFixture),
    };

    const settlementStore = createInMemorySettlementStore([
      {
        handoffId: 'sth-1',
        platformId: 'agroasys-platform',
        platformHandoffId: 'handoff-1',
        tradeId: 'TRD-9001',
        phase: 'stage_2',
        settlementChannel: 'web3layer_escrow',
        displayCurrency: 'USD',
        displayAmount: 125000,
        assetSymbol: 'USDC',
        assetAmount: 125000,
        ricardianHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        externalReference: 'EXT-1',
        metadata: {},
        executionStatus: 'confirmed',
        reconciliationStatus: 'matched',
        callbackStatus: 'delivered',
        providerStatus: 'confirmed',
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        extrinsicHash: null,
        latestEventId: 'evt-1',
        latestEventType: 'reconciled',
        latestEventDetail: 'Settlement confirmed and reconciled.',
        latestEventAt: '2026-03-14T10:05:00.000Z',
        callbackDeliveredAt: '2026-03-14T10:06:00.000Z',
        requestId: 'req-1',
        sourceApiKeyId: 'platform-main',
        createdAt: '2026-03-14T09:00:00.000Z',
        updatedAt: '2026-03-14T10:06:00.000Z',
      },
    ]);
    const ricardianClient = {
      getDocument: jest.fn().mockRejectedValue(new Error('ricardian service unavailable')),
    } as unknown as RicardianClient;
    const complianceStore = {
      listTradeDecisions: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    } as unknown as ComplianceStore;

    const service = new EvidenceReadService(
      tradeReadService,
      settlementStore,
      ricardianClient,
      complianceStore,
      createInMemoryGovernanceActionStore(governanceFixture),
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const result = await service.getRicardianDocument('TRD-9001');

    expect(result.verification.status).toBe('unavailable');
    expect(result.verification.tradeHashMatchesDocument).toBeNull();
    expect(result.verification.settlementHashMatchesTrade).toBe(true);
    expect(result.freshness.available).toBe(false);
    expect(result.freshness.degradedReason).toContain('ricardian service unavailable');
  });

  test('preserves successful evidence reads when one source degrades', async () => {
    const tradeReadService: TradeReadReader = {
      checkReadiness: jest.fn(),
      listTrades: jest.fn(),
      getTrade: jest.fn().mockResolvedValue(tradeFixture),
    };

    const settlementStore = createInMemorySettlementStore();
    const ricardianClient = { getDocument: jest.fn() } as unknown as RicardianClient;
    const complianceStore = {
      listTradeDecisions: jest.fn().mockRejectedValue(new Error('compliance store unavailable')),
    } as unknown as ComplianceStore;

    const service = new EvidenceReadService(
      tradeReadService,
      settlementStore,
      ricardianClient,
      complianceStore,
      createInMemoryGovernanceActionStore(governanceFixture),
      () => new Date('2026-03-14T11:00:00.000Z'),
    );

    const result = await service.getTradeEvidence('TRD-9001');

    expect(result.governanceActions).toHaveLength(1);
    expect(result.complianceDecisions).toHaveLength(0);
    expect(result.freshness.available).toBe(false);
    expect(result.freshness.degradedReason).toContain('compliance store unavailable');
    expect(result.freshness.sourceFreshAt).toBe('2026-03-14T10:06:00.000Z');
  });
});
