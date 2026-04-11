/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { Router } from 'express';
import { createApp } from '../src/app';
import type { GatewayConfig } from '../src/config/env';
import type { AuthSessionClient } from '../src/core/authSessionClient';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import { ComplianceService } from '../src/core/complianceService';
import { createInMemoryComplianceStore } from '../src/core/complianceStore';
import { createPassthroughComplianceWriteStore } from '../src/core/complianceWriteStore';
import { GatewayErrorHandlerWorkflow } from '../src/core/errorHandlerWorkflow';
import { createInMemoryFailedOperationStore } from '../src/core/failedOperationStore';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import { createComplianceRouter } from '../src/routes/compliance';

const baseConfig: GatewayConfig = {
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
  enableMutations: true,
  writeAllowlist: ['uid-admin'],
  governanceQueueTtlSeconds: 86400,
  settlementIngressEnabled: false,
  settlementServiceAuthApiKeysJson: '[]',
  settlementServiceAuthMaxSkewSeconds: 300,
  settlementServiceAuthNonceTtlSeconds: 600,
  settlementCallbackEnabled: false,
  settlementCallbackRequestTimeoutMs: 5000,
  settlementCallbackPollIntervalMs: 5000,
  settlementCallbackMaxAttempts: 8,
  settlementCallbackInitialBackoffMs: 2000,
  settlementCallbackMaxBackoffMs: 60000,
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
  corsAllowedOrigins: [],
  corsAllowNoOrigin: true,
  rateLimitEnabled: true,
  allowInsecureDownstreamAuth: true,
};

const ACTIVE_ATTESTATION_WINDOW = {
  issuedAt: '2026-03-20T10:00:00.000Z',
  expiresAt: '2099-03-30T10:00:00.000Z',
} as const;

function buildDecisionBody(overrides: Record<string, unknown> = {}) {
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
      ...ACTIVE_ATTESTATION_WINDOW,
      providerRef: 'provider-ref-1',
      evidenceRef: 'evidence-bundle-1',
      referenceHash: `0x${'a'.repeat(64)}`,
    },
    audit: {
      reason: 'Documented compliance control action for dashboard workflow.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-1100' }],
      ticketRef: 'AGRO-1100',
    },
    ...overrides,
  };
}

function buildControlBody(overrides: Record<string, unknown> = {}) {
  return {
    reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
    audit: {
      reason: 'Documented operational control for oracle progression.',
      evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-1101' }],
      ticketRef: 'AGRO-1101',
    },
    ...overrides,
  };
}

interface StartServerOptions {
  sessionRole?: 'admin' | 'buyer' | null;
  enableMutations?: boolean;
  writeAllowlist?: string[];
  failCreateDecision?: boolean;
}

async function startServer(options: StartServerOptions = {}) {
  const config: GatewayConfig = {
    ...baseConfig,
    enableMutations: options.enableMutations ?? baseConfig.enableMutations,
    writeAllowlist: options.writeAllowlist ?? baseConfig.writeAllowlist,
  };

  const authSessionClient: AuthSessionClient = {
    resolveSession: jest.fn().mockImplementation(async (token: string) => {
      if (options.sessionRole === null) {
        return null;
      }

      const role = options.sessionRole ?? (token === 'session-admin-2' ? 'admin' : 'admin');
      const sessionToken = token || 'session-admin';
      return {
        accountId:
          role === 'admin'
            ? sessionToken === 'session-admin-2'
              ? 'acct-admin-2'
              : 'acct-admin'
            : 'acct-buyer',
        userId:
          role === 'admin'
            ? sessionToken === 'session-admin-2'
              ? 'uid-admin-2'
              : 'uid-admin'
            : 'uid-buyer',
        walletAddress:
          role === 'admin'
            ? sessionToken === 'session-admin-2'
              ? '0x00000000000000000000000000000000000000ac'
              : '0x00000000000000000000000000000000000000aa'
            : '0x00000000000000000000000000000000000000bb',
        role,
        email:
          role === 'admin'
            ? sessionToken === 'session-admin-2'
              ? 'admin2@agroasys.io'
              : 'admin@agroasys.io'
            : 'buyer@agroasys.io',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    }),
    checkReadiness: jest.fn(),
  };

  const complianceStore = createInMemoryComplianceStore();
  const auditLogStore = createInMemoryAuditLogStore();
  const failedOperationStore = createInMemoryFailedOperationStore();
  const idempotencyStore = createInMemoryIdempotencyStore();
  const complianceService = new ComplianceService(
    complianceStore,
    createPassthroughComplianceWriteStore(complianceStore, auditLogStore),
  );
  const failedOperationWorkflow = new GatewayErrorHandlerWorkflow(
    failedOperationStore,
    auditLogStore,
  );

  if (options.failCreateDecision) {
    jest
      .spyOn(complianceService, 'createDecision')
      .mockRejectedValue(new Error('compliance store unavailable'));
  }

  const router = Router();
  router.use(
    createComplianceRouter({
      authSessionClient,
      config,
      complianceService,
      idempotencyStore,
      failedOperationWorkflow,
    }),
  );

  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck: async () => [{ name: 'postgres', status: 'ok' }],
    extraRouter: router,
  });

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`,
    auditLogStore,
    failedOperationStore,
  };
}

async function createDecision(
  baseUrl: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  return fetch(`${baseUrl}/compliance/decisions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer session-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

describe('gateway compliance routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateDecision = createSchemaValidator(
    spec,
    '#/components/schemas/ComplianceDecisionResponse',
  );
  const validateDecisionList = createSchemaValidator(
    spec,
    '#/components/schemas/ComplianceDecisionListResponse',
  );
  const validateTradeStatus = createSchemaValidator(
    spec,
    '#/components/schemas/ComplianceTradeStatusResponse',
  );
  const validateAttestationStatus = createSchemaValidator(
    spec,
    '#/components/schemas/ComplianceTradeAttestationStatusResponse',
  );
  const validateError = createSchemaValidator(spec, '#/components/schemas/ErrorResponse');

  test('OpenAPI spec exposes all compliance endpoints', () => {
    const paths = [
      '/compliance/decisions',
      '/compliance/decisions/{decisionId}',
      '/compliance/trades/{tradeId}',
      '/compliance/trades/{tradeId}/attestation-status',
      '/compliance/trades/{tradeId}/decisions',
      '/compliance/trades/{tradeId}/block-oracle-progression',
      '/compliance/trades/{tradeId}/resume-oracle-progression',
    ];

    paths.forEach((routePath) => {
      const method =
        routePath === '/compliance/decisions'
          ? 'post'
          : routePath.includes('block-') || routePath.includes('resume-')
            ? 'post'
            : 'get';
      expect(hasOperation(spec, method, routePath)).toBe(true);
    });
  });

  test('POST /compliance/decisions records a decision matching the OpenAPI schema', async () => {
    const { server, baseUrl, auditLogStore } = await startServer({
      writeAllowlist: ['uid-admin', 'uid-admin-2'],
    });

    try {
      const response = await createDecision(baseUrl, buildDecisionBody(), 'idem-create-1');
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(validateDecision(payload)).toBe(true);
      expect(payload.data.reasonCode).toBe('CMP_PROVIDER_UNAVAILABLE');
      expect(response.headers.get('x-request-id')).toBeTruthy();
      expect(auditLogStore.entries).toHaveLength(1);
      expect(auditLogStore.entries[0]?.eventType).toBe('compliance.decision.recorded');
      expect(auditLogStore.entries[0]).toMatchObject({
        actionId: payload.data.decisionId,
        idempotencyKey: 'idem-create-1',
        actorId: 'account:acct-admin',
      });
    } finally {
      server.close();
    }
  });

  test('infrastructure failures dead-letter compliance mutations and accumulate retry count by logical operation', async () => {
    const { server, baseUrl, failedOperationStore } = await startServer({
      failCreateDecision: true,
      writeAllowlist: ['uid-admin'],
    });

    try {
      const firstResponse = await createDecision(
        baseUrl,
        buildDecisionBody(),
        'idem-dead-letter-1',
      );
      const firstPayload = await firstResponse.json();
      expect(firstResponse.status).toBe(503);
      expect(validateError(firstPayload)).toBe(true);
      expect(firstPayload.error.details.failedOperationId).toBeTruthy();

      const secondResponse = await createDecision(
        baseUrl,
        buildDecisionBody(),
        'idem-dead-letter-1',
      );
      expect(secondResponse.status).toBe(503);

      const failedOperations = await failedOperationStore.list();
      expect(failedOperations).toHaveLength(1);
      expect(failedOperations[0]).toMatchObject({
        operationType: 'compliance.create_decision',
        failureState: 'open',
        replayEligible: true,
        retryCount: 2,
        idempotencyKey: 'idem-dead-letter-1',
      });
    } finally {
      server.close();
    }
  });

  test('GET compliance decision and trade history match the OpenAPI schema', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const firstResponse = await createDecision(baseUrl, buildDecisionBody(), 'idem-create-2');
      const firstPayload = await firstResponse.json();

      await createDecision(
        baseUrl,
        buildDecisionBody({
          result: 'ALLOW',
          reasonCode: 'CMP_OVERRIDE_ACTIVE',
          overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          correlationId: 'corr-2',
        }),
        'idem-create-3',
      );

      const detailResponse = await fetch(
        `${baseUrl}/compliance/decisions/${firstPayload.data.decisionId}`,
        {
          headers: { Authorization: 'Bearer session-admin' },
        },
      );
      const detailPayload = await detailResponse.json();

      const listResponse = await fetch(`${baseUrl}/compliance/trades/TRD-1/decisions`, {
        headers: { Authorization: 'Bearer session-admin' },
      });
      const listPayload = await listResponse.json();

      expect(detailResponse.status).toBe(200);
      expect(validateDecision(detailPayload)).toBe(true);
      expect(listResponse.status).toBe(200);
      expect(validateDecisionList(listPayload)).toBe(true);
      expect(listPayload.data.items).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  test('GET /compliance/trades/:tradeId returns 404 before any decision exists', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/compliance/trades/TRD-missing`, {
        headers: { Authorization: 'Bearer session-admin' },
      });
      const payload = await response.json();

      expect(response.status).toBe(404);
      expect(validateError(payload)).toBe(true);
    } finally {
      server.close();
    }
  });

  test('GET /compliance/trades/:tradeId/attestation-status returns read-only attestation status matching the OpenAPI schema', async () => {
    const { server, baseUrl } = await startServer();

    try {
      await createDecision(
        baseUrl,
        buildDecisionBody({
          result: 'ALLOW',
          reasonCode: 'CMP_OVERRIDE_ACTIVE',
          overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        'idem-attestation-1',
      );

      const response = await fetch(`${baseUrl}/compliance/trades/TRD-1/attestation-status`, {
        headers: { Authorization: 'Bearer session-admin' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateAttestationStatus(payload)).toBe(true);
      expect(payload.data.attestation.issuer.id).toBe('compliance-provider');
      expect(payload.data.attestation.subjectRef.reference).toBe('subject-1');
      expect(payload.data.availability).toBe('available');
      expect(payload.data.freshness).toBe('current');
    } finally {
      server.close();
    }
  });

  test('GET /compliance/trades/:tradeId/attestation-status preserves last-known attestation metadata during provider outage', async () => {
    const { server, baseUrl } = await startServer();

    try {
      await createDecision(
        baseUrl,
        buildDecisionBody({
          result: 'ALLOW',
          reasonCode: 'CMP_OVERRIDE_ACTIVE',
          overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        'idem-attestation-last-known-1',
      );

      await createDecision(
        baseUrl,
        buildDecisionBody({
          correlationId: 'corr-attestation-outage-2',
          attestation: null,
        }),
        'idem-attestation-last-known-2',
      );

      const response = await fetch(`${baseUrl}/compliance/trades/TRD-1/attestation-status`, {
        headers: { Authorization: 'Bearer session-admin' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateAttestationStatus(payload)).toBe(true);
      expect(payload.data.complianceResult).toBe('DENY');
      expect(payload.data.availability).toBe('unavailable');
      expect(payload.data.freshness).toBe('stale');
      expect(payload.data.degradedReason).toBe('cmp_provider_unavailable');
      expect(payload.data.attestation.attestationId).toBe('att-1');
      expect(payload.data.attestation.issuer.id).toBe('compliance-provider');
    } finally {
      server.close();
    }
  });

  test('block and resume oracle progression match the OpenAPI schema', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const denyResponse = await createDecision(baseUrl, buildDecisionBody(), 'idem-create-4');
      const denyPayload = await denyResponse.json();

      const blockResponse = await fetch(
        `${baseUrl}/compliance/trades/TRD-1/block-oracle-progression`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer session-admin',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem-block-1',
          },
          body: JSON.stringify(buildControlBody({ decisionId: denyPayload.data.decisionId })),
        },
      );
      const blockPayload = await blockResponse.json();

      expect(blockResponse.status).toBe(202);
      expect(validateTradeStatus(blockPayload)).toBe(true);
      expect(blockPayload.data.oracleProgressionBlocked).toBe(true);

      const allowResponse = await createDecision(
        baseUrl,
        buildDecisionBody({
          result: 'ALLOW',
          reasonCode: 'CMP_OVERRIDE_ACTIVE',
          overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          correlationId: 'corr-allow',
        }),
        'idem-create-5',
      );
      const allowPayload = await allowResponse.json();

      const resumeResponse = await fetch(
        `${baseUrl}/compliance/trades/TRD-1/resume-oracle-progression`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer session-admin',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem-resume-1',
          },
          body: JSON.stringify(
            buildControlBody({
              reasonCode: 'CMP_OVERRIDE_ACTIVE',
              decisionId: allowPayload.data.decisionId,
            }),
          ),
        },
      );
      const resumePayload = await resumeResponse.json();

      expect(resumeResponse.status).toBe(202);
      expect(validateTradeStatus(resumePayload)).toBe(true);
      expect(resumePayload.data.oracleProgressionBlocked).toBe(false);
      expect(resumePayload.data.currentResult).toBe('ALLOW');
    } finally {
      server.close();
    }
  });

  test('resume oracle progression rejects stale decision references', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const allowResponse = await createDecision(
        baseUrl,
        buildDecisionBody({
          result: 'ALLOW',
          reasonCode: 'CMP_OVERRIDE_ACTIVE',
          overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          correlationId: 'corr-allow-stale',
        }),
        'idem-create-stale-allow',
      );
      const allowPayload = await allowResponse.json();

      const denyResponse = await createDecision(
        baseUrl,
        buildDecisionBody({
          correlationId: 'corr-deny-stale',
        }),
        'idem-create-stale-deny',
      );
      const denyPayload = await denyResponse.json();

      await fetch(`${baseUrl}/compliance/trades/TRD-1/block-oracle-progression`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-block-stale',
        },
        body: JSON.stringify(buildControlBody({ decisionId: denyPayload.data.decisionId })),
      });

      const resumeResponse = await fetch(
        `${baseUrl}/compliance/trades/TRD-1/resume-oracle-progression`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer session-admin',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem-resume-stale',
          },
          body: JSON.stringify(
            buildControlBody({
              reasonCode: 'CMP_OVERRIDE_ACTIVE',
              decisionId: allowPayload.data.decisionId,
            }),
          ),
        },
      );
      const resumePayload = await resumeResponse.json();

      expect(resumeResponse.status).toBe(409);
      expect(validateError(resumePayload)).toBe(true);
      expect(resumePayload.error.code).toBe('CONFLICT');
      expect(resumePayload.error.message).toContain(
        'latest effective compliance decision must be used',
      );
    } finally {
      server.close();
    }
  });

  test('mutation routes replay the prior response for duplicate idempotency keys', async () => {
    const { server, baseUrl } = await startServer();

    try {
      const requestBody = buildDecisionBody();
      const firstResponse = await createDecision(baseUrl, requestBody, 'idem-create-6');
      const firstPayload = await firstResponse.json();
      const replayResponse = await createDecision(baseUrl, requestBody, 'idem-create-6');
      const replayPayload = await replayResponse.json();

      expect(firstResponse.status).toBe(201);
      expect(replayResponse.status).toBe(201);
      expect(replayPayload).toEqual(firstPayload);
    } finally {
      server.close();
    }
  });

  test('mutation routes scope idempotency by actor and reject client-supplied decision ids', async () => {
    const { server, baseUrl, auditLogStore } = await startServer({
      writeAllowlist: ['uid-admin', 'uid-admin-2'],
    });

    try {
      const sharedBody = buildDecisionBody({
        result: 'ALLOW',
        reasonCode: 'CMP_OVERRIDE_ACTIVE',
        overrideWindowEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      const first = await fetch(`${baseUrl}/compliance/decisions`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-shared-decision',
        },
        body: JSON.stringify(sharedBody),
      });
      const firstPayload = await first.json();

      const second = await fetch(`${baseUrl}/compliance/decisions`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-admin-2',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-shared-decision',
        },
        body: JSON.stringify({
          ...sharedBody,
          correlationId: 'corr-2',
        }),
      });
      const secondPayload = await second.json();

      const invalid = await fetch(`${baseUrl}/compliance/decisions`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-invalid-decision-id',
        },
        body: JSON.stringify({
          ...buildDecisionBody(),
          decisionId: 'client-controlled-decision',
        }),
      });
      const invalidPayload = await invalid.json();

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(firstPayload.data.decisionId).not.toBe(secondPayload.data.decisionId);
      expect(invalid.status).toBe(400);
      expect(validateError(invalidPayload)).toBe(true);
      expect(invalidPayload.error.message).toContain('decisionId is server-generated');
      expect(auditLogStore.entries.map((entry) => entry.actorId)).toEqual(
        expect.arrayContaining(['account:acct-admin', 'account:acct-admin-2']),
      );
    } finally {
      server.close();
    }
  });

  test('mutation routes reject non-admin callers and disabled write gates', async () => {
    const buyerServer = await startServer({ sessionRole: 'buyer' });
    try {
      const buyerResponse = await fetch(`${buyerServer.baseUrl}/compliance/decisions`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-buyer',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-buyer',
        },
        body: JSON.stringify(buildDecisionBody()),
      });
      const buyerPayload = await buyerResponse.json();

      expect(buyerResponse.status).toBe(403);
      expect(validateError(buyerPayload)).toBe(true);
    } finally {
      buyerServer.server.close();
    }

    const disabledServer = await startServer({ enableMutations: false });
    try {
      const disabledResponse = await fetch(`${disabledServer.baseUrl}/compliance/decisions`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-admin',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-disabled',
        },
        body: JSON.stringify(buildDecisionBody()),
      });
      const disabledPayload = await disabledResponse.json();

      expect(disabledResponse.status).toBe(403);
      expect(validateError(disabledPayload)).toBe(true);
    } finally {
      disabledServer.server.close();
    }
  });
});
