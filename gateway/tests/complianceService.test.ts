/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import {
  ComplianceDecisionRecord,
  createInMemoryComplianceStore,
  OracleProgressionBlockRecord,
} from '../src/core/complianceStore';
import {
  ComplianceService,
  validateComplianceDecisionCreateRequest,
} from '../src/core/complianceService';
import { createPassthroughComplianceWriteStore } from '../src/core/complianceWriteStore';
import { GatewayPrincipal } from '../src/middleware/auth';
import { RequestContext } from '../src/middleware/requestContext';

function buildPrincipal(): GatewayPrincipal {
  return {
    sessionReference: 'sha256:sess-admin',
    gatewayRoles: ['operator:read', 'operator:write'],
    writeEnabled: true,
    session: {
      userId: 'uid-admin',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      role: 'admin',
      email: 'admin@agroasys.io',
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    },
  };
}

function buildRequestContext(): RequestContext {
  return {
    requestId: 'req-1',
    correlationId: 'corr-1',
    startedAtMs: Date.now(),
  };
}

function buildAudit() {
  return {
    reason: 'Documented compliance control action for operator workflow.',
    ticketRef: 'AGRO-1000',
    evidenceLinks: [{ kind: 'ticket' as const, uri: 'https://tickets.agroasys.local/AGRO-1000' }],
  };
}

function buildDecisionInput(overrides: Record<string, unknown> = {}) {
  return {
    tradeId: 'TRD-1',
    decisionType: 'KYT',
    result: 'DENY',
    reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
    provider: 'compliance-provider',
    providerRef: 'provider-ref-1',
    subjectId: 'subject-1',
    subjectType: 'counterparty',
    riskLevel: 'high',
    correlationId: 'corr-1',
    attestation: {
      attestationId: 'att-1',
      attestationType: 'kyt',
      status: 'active',
      issuer: {
        id: 'compliance-provider',
        kind: 'provider',
        displayName: 'Compliance Provider',
      },
      subjectRef: {
        type: 'counterparty',
        reference: 'subject-1',
      },
      issuedAt: '2026-03-20T10:00:00.000Z',
      expiresAt: '2026-03-30T10:00:00.000Z',
      providerRef: 'provider-ref-1',
      evidenceRef: 'evidence-bundle-1',
      referenceHash: `0x${'a'.repeat(64)}`,
    },
    audit: buildAudit(),
    ...overrides,
  };
}

function buildService() {
  const store = createInMemoryComplianceStore();
  const auditLogStore = createInMemoryAuditLogStore();
  const service = new ComplianceService(
    store,
    createPassthroughComplianceWriteStore(store, auditLogStore),
  );

  return { store, auditLogStore, service };
}

describe('compliance service', () => {
  test('enforces fail-closed mapping for provider unavailable decisions', () => {
    expect(() => validateComplianceDecisionCreateRequest(buildDecisionInput({
      result: 'ALLOW',
      reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
    }))).toThrow('CMP_PROVIDER_UNAVAILABLE requires result=DENY');
  });

  test('records append-only decisions and audit trail entries', async () => {
    const { store, auditLogStore, service } = buildService();
    const principal = buildPrincipal();
    const requestContext = buildRequestContext();

    const first = await service.createDecision({
      ...validateComplianceDecisionCreateRequest(buildDecisionInput()),
      principal,
      requestContext,
      routePath: '/api/dashboard-gateway/v1/compliance/decisions',
      idempotencyKey: 'idem-1',
    });

    const second = await service.createDecision({
      ...validateComplianceDecisionCreateRequest(buildDecisionInput({
        result: 'ALLOW',
        reasonCode: 'CMP_OVERRIDE_ACTIVE',
        overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        correlationId: 'corr-2',
      })),
      principal,
      requestContext: { ...requestContext, requestId: 'req-2', correlationId: 'corr-2' },
      routePath: '/api/dashboard-gateway/v1/compliance/decisions',
      idempotencyKey: 'idem-2',
    });

    const firstStored = await store.getDecision(first.decisionId);
    const secondStored = await store.getDecision(second.decisionId);
    const listed = await service.listTradeDecisions('TRD-1', 10);
    const status = await service.getTradeStatus('TRD-1');

    expect(firstStored?.result).toBe('DENY');
    expect(secondStored?.result).toBe('ALLOW');
    expect(listed.items).toHaveLength(2);
    expect(status?.currentResult).toBe('ALLOW');
    expect(auditLogStore.entries).toHaveLength(2);
    expect(auditLogStore.entries.map((entry) => entry.eventType)).toEqual([
      'compliance.decision.recorded',
      'compliance.decision.recorded',
    ]);
  });

  test('derives read-only attestation status from the latest attested decision', async () => {
    const { service } = buildService();
    const principal = buildPrincipal();
    const requestContext = buildRequestContext();

    await service.createDecision({
      ...validateComplianceDecisionCreateRequest(buildDecisionInput({
        result: 'ALLOW',
        reasonCode: 'CMP_OVERRIDE_ACTIVE',
        overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })),
      principal,
      requestContext,
      routePath: '/api/dashboard-gateway/v1/compliance/decisions',
      idempotencyKey: 'idem-attestation-available',
    });

    const status = await service.getAttestationStatus('TRD-1');

    expect(status).toMatchObject({
      tradeId: 'TRD-1',
      decisionType: 'KYT',
      complianceResult: 'ALLOW',
      availability: 'available',
      freshness: 'current',
      attestation: {
        attestationId: 'att-1',
        issuer: { id: 'compliance-provider' },
      },
    });
  });

  test('marks attestation status unavailable when latest attested decision records provider outage', async () => {
    const { service } = buildService();
    const principal = buildPrincipal();
    const requestContext = buildRequestContext();

    await service.createDecision({
      ...validateComplianceDecisionCreateRequest(buildDecisionInput()),
      principal,
      requestContext,
      routePath: '/api/dashboard-gateway/v1/compliance/decisions',
      idempotencyKey: 'idem-attestation-unavailable',
    });

    const status = await service.getAttestationStatus('TRD-1');

    expect(status).toMatchObject({
      tradeId: 'TRD-1',
      complianceResult: 'DENY',
      availability: 'unavailable',
      freshness: 'stale',
      degradedReason: 'cmp_provider_unavailable',
    });
  });

  test('assigns monotonic decision timestamps for same-trade writes', async () => {
    const { service } = buildService();
    const principal = buildPrincipal();
    const requestContext = buildRequestContext();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    try {
      const first = await service.createDecision({
        ...validateComplianceDecisionCreateRequest(buildDecisionInput({
          tradeId: 'TRD-2',
          correlationId: 'corr-a',
        })),
        principal,
        requestContext,
        routePath: '/api/dashboard-gateway/v1/compliance/decisions',
        idempotencyKey: 'idem-a',
      });

      const second = await service.createDecision({
        ...validateComplianceDecisionCreateRequest(buildDecisionInput({
          tradeId: 'TRD-2',
          correlationId: 'corr-b',
        })),
        principal,
        requestContext: { ...requestContext, requestId: 'req-b', correlationId: 'corr-b' },
        routePath: '/api/dashboard-gateway/v1/compliance/decisions',
        idempotencyKey: 'idem-b',
      });

      expect(Date.parse(second.decidedAt)).toBeGreaterThan(Date.parse(first.decidedAt));
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('requires an ALLOW decision before resuming oracle progression', async () => {
    const { service } = buildService();
    const principal = buildPrincipal();
    const requestContext = buildRequestContext();

    const denyDecision = await service.createDecision({
      ...validateComplianceDecisionCreateRequest(buildDecisionInput()),
      principal,
      requestContext,
      routePath: '/api/dashboard-gateway/v1/compliance/decisions',
      idempotencyKey: 'idem-deny',
    });

    await service.blockOracleProgression({
      tradeId: 'TRD-1',
      reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
      decisionId: denyDecision.decisionId,
      audit: buildAudit(),
      principal,
      requestContext: { ...requestContext, requestId: 'req-block' },
      routePath: '/api/dashboard-gateway/v1/compliance/trades/TRD-1/block-oracle-progression',
      idempotencyKey: 'idem-block',
    });

    await expect(
      service.resumeOracleProgression({
        tradeId: 'TRD-1',
        reasonCode: 'CMP_PROVIDER_RECOVERED',
        decisionId: denyDecision.decisionId,
        audit: buildAudit(),
        principal,
        requestContext: { ...requestContext, requestId: 'req-resume-deny' },
        routePath: '/api/dashboard-gateway/v1/compliance/trades/TRD-1/resume-oracle-progression',
        idempotencyKey: 'idem-resume-deny',
      }),
    ).rejects.toThrow('latest effective compliance decision must be ALLOW');
  });

  test('rejects resume attempts that cite a stale ALLOW decision', async () => {
    const { service } = buildService();
    const principal = buildPrincipal();
    const requestContext = buildRequestContext();

    const allowDecision = await service.createDecision({
      ...validateComplianceDecisionCreateRequest(buildDecisionInput({
        result: 'ALLOW',
        reasonCode: 'CMP_OVERRIDE_ACTIVE',
        overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })),
      principal,
      requestContext,
      routePath: '/api/dashboard-gateway/v1/compliance/decisions',
      idempotencyKey: 'idem-allow',
    });

    const denyDecision = await service.createDecision({
      ...validateComplianceDecisionCreateRequest(buildDecisionInput({
        correlationId: 'corr-2',
      })),
      principal,
      requestContext: { ...requestContext, requestId: 'req-deny', correlationId: 'corr-2' },
      routePath: '/api/dashboard-gateway/v1/compliance/decisions',
      idempotencyKey: 'idem-deny-latest',
    });

    await service.blockOracleProgression({
      tradeId: 'TRD-1',
      reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
      decisionId: denyDecision.decisionId,
      audit: buildAudit(),
      principal,
      requestContext: { ...requestContext, requestId: 'req-block-stale' },
      routePath: '/api/dashboard-gateway/v1/compliance/trades/TRD-1/block-oracle-progression',
      idempotencyKey: 'idem-block-stale',
    });

    await expect(
      service.resumeOracleProgression({
        tradeId: 'TRD-1',
        reasonCode: 'CMP_OVERRIDE_ACTIVE',
        decisionId: allowDecision.decisionId,
        audit: buildAudit(),
        principal,
        requestContext: { ...requestContext, requestId: 'req-resume-stale' },
        routePath: '/api/dashboard-gateway/v1/compliance/trades/TRD-1/resume-oracle-progression',
        idempotencyKey: 'idem-resume-stale',
      }),
    ).rejects.toThrow('latest effective compliance decision must be used');
  });

  test('refuses resume when override window has expired', async () => {
    const expiredDecision: ComplianceDecisionRecord = {
      decisionId: 'decision-expired',
      tradeId: 'TRD-2',
      decisionType: 'KYT',
      result: 'ALLOW',
      reasonCode: 'CMP_OVERRIDE_ACTIVE',
      provider: 'compliance-provider',
      providerRef: 'provider-ref-expired',
      subjectId: 'subject-2',
      subjectType: 'counterparty',
      riskLevel: 'medium',
      correlationId: 'corr-expired',
      decidedAt: '2026-03-07T10:00:00.000Z',
      overrideWindowEndsAt: '2026-03-07T09:00:00.000Z',
      blockState: 'blocked',
      audit: {
        reason: 'Expired override record retained for audit.',
        evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-1001' }],
        ticketRef: 'AGRO-1001',
        actorSessionId: 'sess-admin',
        actorWallet: '0x00000000000000000000000000000000000000aa',
        actorRole: 'admin',
        createdAt: '2026-03-07T10:00:00.000Z',
        requestedBy: 'uid-admin',
      },
    };

    const existingBlock: OracleProgressionBlockRecord = {
      tradeId: 'TRD-2',
      latestDecisionId: 'decision-expired',
      blockState: 'blocked',
      reasonCode: 'CMP_OVERRIDE_ACTIVE',
      requestId: 'req-existing',
      correlationId: 'corr-existing',
      audit: expiredDecision.audit,
      blockedAt: '2026-03-07T10:05:00.000Z',
      resumedAt: null,
      updatedAt: '2026-03-07T10:05:00.000Z',
    };

    const store = createInMemoryComplianceStore([expiredDecision], [existingBlock]);
    const auditLogStore = createInMemoryAuditLogStore();
    const service = new ComplianceService(
      store,
      createPassthroughComplianceWriteStore(store, auditLogStore),
    );

    await expect(
      service.resumeOracleProgression({
        tradeId: 'TRD-2',
        reasonCode: 'CMP_OVERRIDE_ACTIVE',
        decisionId: 'decision-expired',
        audit: buildAudit(),
        principal: buildPrincipal(),
        requestContext: buildRequestContext(),
        routePath: '/api/dashboard-gateway/v1/compliance/trades/TRD-2/resume-oracle-progression',
        idempotencyKey: 'idem-expired',
      }),
    ).rejects.toThrow('active override window has expired');
  });
});
