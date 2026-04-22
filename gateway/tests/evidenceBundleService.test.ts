/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryComplianceStore } from '../src/core/complianceStore';
import { GatewayEvidenceBundleService } from '../src/core/evidenceBundleService';
import { createInMemoryEvidenceBundleStore } from '../src/core/evidenceBundleStore';
import type { ComplianceStore } from '../src/core/complianceStore';
import type { DashboardTradeRecord, TradeReadReader } from '../src/core/tradeReadService';
import type { GatewayPrincipal } from '../src/middleware/auth';
import type { RequestContext } from '../src/middleware/requestContext';

const trade: DashboardTradeRecord = {
  id: 'TRD-247',
  buyer: 'buyer-1',
  supplier: 'supplier-1',
  amount: 1200,
  currency: 'USDC',
  status: 'locked',
  txHash: '0xtrade',
  createdAt: '2026-03-14T09:00:00.000Z',
  updatedAt: '2026-03-14T09:30:00.000Z',
  ricardianHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  platformFee: 20,
  logisticsAmount: 35,
  timeline: [],
  complianceStatus: 'pass',
  settlement: {
    handoffId: 'handoff-247',
    platformId: 'agroasys',
    platformHandoffId: 'platform-247',
    phase: 'locked',
    settlementChannel: 'usdc',
    displayCurrency: 'USDC',
    displayAmount: 1200,
    executionStatus: 'confirmed',
    reconciliationStatus: 'matched',
    callbackStatus: 'delivered',
    providerStatus: 'ok',
    txHash: '0xsettlement',
    externalReference: 'ref-247',
    latestEventType: 'confirmed',
    latestEventDetail: 'Settled',
    latestEventAt: '2026-03-14T09:20:00.000Z',
    callbackDeliveredAt: '2026-03-14T09:25:00.000Z',
    createdAt: '2026-03-14T09:05:00.000Z',
    updatedAt: '2026-03-14T09:25:00.000Z',
  },
};

function buildPrincipal(
  overrides: Omit<Partial<GatewayPrincipal['session']>, 'walletAddress'> & {
    walletAddress?: string | null;
  } = {},
): GatewayPrincipal {
  const session = {
    userId: 'uid-admin',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    role: 'admin',
    capabilities: [],
    signerAuthorizations: [],
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  } as GatewayPrincipal['session'];

  return {
    gatewayRoles: ['operator:read', 'operator:write'],
    operatorActionCapabilities: [],
    treasuryCapabilities: [
      'treasury:read',
      'treasury:prepare',
      'treasury:approve',
      'treasury:execute_match',
      'treasury:close',
    ],
    sessionReference: 'sess-247',
    writeEnabled: true,
    session,
  };
}

const requestContext: RequestContext = {
  requestId: 'req-247',
  correlationId: 'corr-247',
  startedAtMs: Date.now(),
};

function buildTradeReader(record: DashboardTradeRecord): TradeReadReader {
  return {
    checkReadiness: jest.fn(),
    listTrades: jest.fn().mockResolvedValue([record]),
    getTrade: jest.fn().mockResolvedValue(record),
  };
}

describe('GatewayEvidenceBundleService', () => {
  test('generates and persists bundle metadata with artifact references', async () => {
    const complianceStore = createInMemoryComplianceStore([
      {
        decisionId: 'dec-1',
        tradeId: trade.id,
        decisionType: 'KYT',
        result: 'ALLOW',
        reasonCode: 'CMP_OK',
        provider: 'provider-a',
        providerRef: 'provider-ref-1',
        subjectId: 'subject-1',
        subjectType: 'trade',
        riskLevel: 'low',
        correlationId: 'corr-1',
        decidedAt: '2026-03-14T09:10:00.000Z',
        overrideWindowEndsAt: null,
        blockState: 'not_blocked',
        audit: {
          reason: 'Trade cleared by compliance.',
          evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets/AGRO-247' }],
          ticketRef: 'AGRO-247',
          actorSessionId: 'sess-comp',
          actorWallet: '0x00000000000000000000000000000000000000bb',
          actorRole: 'admin',
          createdAt: '2026-03-14T09:10:00.000Z',
          requestedBy: 'uid-compliance',
        },
      },
    ]);

    const service = new GatewayEvidenceBundleService(
      createInMemoryEvidenceBundleStore(),
      buildTradeReader(trade),
      complianceStore,
      'http://127.0.0.1:3100/api/ricardian/v1',
      () => new Date('2026-03-14T10:00:00.000Z'),
    );

    const manifest = await service.generate({
      tradeId: trade.id,
      principal: buildPrincipal(),
      requestContext,
    });

    expect(manifest.manifestDigest).toMatch(/^sha256:/);
    expect(manifest.available).toBe(true);
    expect(manifest.generatedBy.userId).toBe('uid-admin');
    expect(manifest.artifactReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: 'bundle-manifest',
          href: expect.stringContaining(`/evidence/bundles/${manifest.bundleId}/download`),
        }),
        expect.objectContaining({
          artifactId: 'ricardian-document',
          available: true,
          href: '/api/dashboard-gateway/v1/ricardian/TRD-247',
        }),
      ]),
    );
    expect(manifest.evidenceReferences).toEqual([
      expect.objectContaining({
        sourceType: 'compliance_decision',
        sourceId: 'dec-1',
        uri: 'https://tickets/AGRO-247',
      }),
    ]);

    const stored = await service.get(manifest.bundleId);
    expect(stored).toEqual(manifest);
  });

  test('marks the manifest degraded when ricardian lookup is not configured', async () => {
    const service = new GatewayEvidenceBundleService(
      createInMemoryEvidenceBundleStore(),
      buildTradeReader(trade),
      createInMemoryComplianceStore(),
      undefined,
      () => new Date('2026-03-14T10:00:00.000Z'),
    );

    const manifest = await service.generate({
      tradeId: trade.id,
      principal: buildPrincipal(),
      requestContext,
    });

    expect(manifest.available).toBe(false);
    expect(manifest.degradedReason).toContain('GATEWAY_RICARDIAN_BASE_URL');
    expect(manifest.artifactReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: 'ricardian-document',
          available: false,
        }),
      ]),
    );
  });

  test('generates a degraded manifest when compliance evidence sources are unavailable', async () => {
    const complianceStore = {
      getTradeStatus: jest.fn().mockRejectedValue(new Error('compliance status unavailable')),
      getOracleProgressionBlock: jest
        .fn()
        .mockRejectedValue(new Error('oracle progression unavailable')),
      listTradeDecisions: jest.fn().mockRejectedValue(new Error('trade decisions unavailable')),
    } as unknown as ComplianceStore;

    const service = new GatewayEvidenceBundleService(
      createInMemoryEvidenceBundleStore(),
      buildTradeReader(trade),
      complianceStore,
      'http://127.0.0.1:3100/api/ricardian/v1',
      () => new Date('2026-03-14T10:00:00.000Z'),
    );

    const manifest = await service.generate({
      tradeId: trade.id,
      principal: buildPrincipal(),
      requestContext,
    });

    expect(manifest.available).toBe(false);
    expect(manifest.degradedReason).toContain('compliance status unavailable');
    expect(manifest.degradedReason).toContain('trade decisions unavailable');
    expect(manifest.evidenceReferences).toEqual([]);
    expect(manifest.artifactReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: 'bundle-manifest',
          href: expect.stringContaining(`/evidence/bundles/${manifest.bundleId}/download`),
        }),
      ]),
    );
  });

  test('persists a null generatedBy wallet when the operator session is not wallet-bound', async () => {
    const service = new GatewayEvidenceBundleService(
      createInMemoryEvidenceBundleStore(),
      buildTradeReader(trade),
      createInMemoryComplianceStore(),
      'http://127.0.0.1:3100/api/ricardian/v1',
      () => new Date('2026-03-14T10:00:00.000Z'),
    );

    const manifest = await service.generate({
      tradeId: trade.id,
      principal: buildPrincipal({ walletAddress: null }),
      requestContext,
    });

    expect(manifest.generatedBy.walletAddress).toBeNull();

    const stored = await service.get(manifest.bundleId);
    expect(stored?.generatedBy.walletAddress).toBeNull();
  });
});
