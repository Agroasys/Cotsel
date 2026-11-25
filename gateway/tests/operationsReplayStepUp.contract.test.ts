/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import type { AuthSession, AuthSessionClient } from '../src/core/authSessionClient';
import { ComplianceService } from '../src/core/complianceService';
import { createInMemoryComplianceStore } from '../src/core/complianceStore';
import { createPassthroughComplianceWriteStore } from '../src/core/complianceWriteStore';
import {
  GatewayErrorHandlerWorkflow,
  GatewayFailedOperationReplayer,
} from '../src/core/errorHandlerWorkflow';
import { createInMemoryFailedOperationStore } from '../src/core/failedOperationStore';
import { createInMemoryIdempotencyStore } from '../src/core/idempotencyStore';
import type { SettlementCallbackDispatcher } from '../src/core/settlementCallbackDispatcher';
import { GatewayError } from '../src/errors';
import type { GatewayPrincipal } from '../src/middleware/auth';
import { createOperationsRouter } from '../src/routes/operations';
import { sendInProcessRequest } from './support/inProcessHttp';
import { freshStepUp } from './support/stepUp';
import { baseTestGatewayConfig } from './support/testConfig';

const complianceOperations = [
  'compliance.create_decision',
  'compliance.block_oracle_progression',
  'compliance.resume_oracle_progression',
] as const;

async function harness(operation: (typeof complianceOperations)[number]) {
  const session: AuthSession = {
    accountId: 'account-admin',
    userId: 'uid-admin',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    role: 'admin',
    capabilities: ['operations:replay', 'compliance:write'],
    signerAuthorizations: [],
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    authentication: freshStepUp(360),
  };
  const principal: GatewayPrincipal = {
    session,
    sessionReference: `sha256:${'a'.repeat(64)}`,
    gatewayRoles: ['operator:read', 'operator:write'],
    operatorActionCapabilities: ['operations:replay', 'compliance:write'],
    treasuryCapabilities: [],
    writeEnabled: true,
  };
  const auditLogStore = createInMemoryAuditLogStore();
  const complianceStore = createInMemoryComplianceStore();
  const complianceService = new ComplianceService(
    complianceStore,
    createPassthroughComplianceWriteStore(complianceStore, auditLogStore),
  );
  const createDecision = jest.spyOn(complianceService, 'createDecision');
  const blockOracleProgression = jest.spyOn(complianceService, 'blockOracleProgression');
  const resumeOracleProgression = jest.spyOn(complianceService, 'resumeOracleProgression');
  const failedOperationStore = createInMemoryFailedOperationStore();
  const workflow = new GatewayErrorHandlerWorkflow(failedOperationStore);
  const audit = {
    reason: 'Retry the recorded compliance operation.',
    evidenceLinks: [{ kind: 'ticket' as const, uri: 'https://tickets.example.test/INC-970' }],
    ticketRef: 'INC-970',
  };
  const routePath = '/api/dashboard-gateway/v1/compliance/decisions';
  const record = await workflow.captureFailure({
    operationType: operation,
    operationKey: `${operation}:original-idempotency-key`,
    targetService: 'gateway_compliance_write',
    route: routePath,
    method: 'POST',
    requestContext: { requestId: 'original-request', correlationId: 'original-correlation' },
    idempotencyKey: 'original-idempotency-key',
    principal,
    replaySpec:
      operation === 'compliance.create_decision'
        ? {
            type: operation,
            routePath,
            payload: {
              tradeId: 'TRD-970',
              decisionType: 'KYT',
              result: 'DENY',
              reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
              provider: 'provider',
              providerRef: 'provider-reference',
              subjectId: 'subject',
              subjectType: 'counterparty',
              riskLevel: 'high',
              overrideWindowEndsAt: null,
              correlationId: 'original-correlation',
              attestation: null,
              audit,
            },
          }
        : {
            type: operation,
            routePath,
            payload: {
              tradeId: 'TRD-970',
              reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
              decisionId: null,
              audit,
            },
          },
    error: new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Compliance write unavailable'),
  });
  if (!record) throw new Error('Expected a replayable failed operation');
  const idempotencyStore = createInMemoryIdempotencyStore();
  const createPending = jest.spyOn(idempotencyStore, 'createPending');
  const config = {
    ...baseTestGatewayConfig,
    enableMutations: true,
    writeAllowlist: ['uid-admin', 'uid-replay'],
  };
  const options = {
    config,
    authSessionClient: {
      resolveSession: jest.fn(async () => ({ ...session })),
      checkReadiness: jest.fn(),
    } satisfies AuthSessionClient,
    operationsSummaryService: { getOperationsSummary: jest.fn() },
    failedOperationStore,
    failedOperationReplayer: new GatewayFailedOperationReplayer(
      failedOperationStore,
      complianceService,
      {} as SettlementCallbackDispatcher,
    ),
    idempotencyStore,
    auditLogStore,
  };
  const app = createApp(config, {
    version: 'test',
    commitSha: 'review-970',
    buildTime: config.buildTime,
    readinessCheck: async () => [],
    extraRouter: createOperationsRouter(options),
  });
  return {
    session,
    auditLogStore,
    failedOperationStore,
    record,
    createPending,
    calls: [createDecision, blockOracleProgression, resumeOracleProgression],
    replay: () =>
      sendInProcessRequest(app, {
        method: 'POST',
        path: `/api/dashboard-gateway/v1/operations/failed-operations/${record.failedOperationId}/replay`,
        headers: {
          Authorization: 'Bearer operator-session',
          'Idempotency-Key': 'retry-970',
          'X-Request-Id': 'replay-request-970',
        },
      }),
  };
}

describe('failed-operation replay step-up boundary', () => {
  test.each(complianceOperations)(
    'refuses stale assurance before %s replay or idempotency',
    async (operation) => {
      const h = await harness(operation);
      const response = await h.replay();
      expect(response.status).toBe(403);
      expect(response.json()).toMatchObject({ error: { details: { reason: 'step_up_required' } } });
      expect(h.createPending).not.toHaveBeenCalled();
      for (const call of h.calls) expect(call).not.toHaveBeenCalled();
      expect((await h.failedOperationStore.get(h.record.failedOperationId))?.failureState).toBe(
        'open',
      );
    },
  );

  test('refuses missing assurance', async () => {
    const h = await harness('compliance.create_decision');
    delete h.session.authentication;
    expect((await h.replay()).status).toBe(403);
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.calls[0]).not.toHaveBeenCalled();
  });

  test('fresh same-key retry executes once and binds assurance to the real compliance audit', async () => {
    const h = await harness('compliance.create_decision');
    expect((await h.replay()).status).toBe(403);
    h.session.accountId = 'account-replay';
    h.session.userId = 'uid-replay';
    h.session.authentication = freshStepUp(10);
    expect((await h.replay()).status).toBe(202);
    expect((await h.replay()).status).toBe(202);
    expect(h.calls[0]).toHaveBeenCalledTimes(1);
    expect(h.auditLogStore.entries).toContainEqual(
      expect.objectContaining({
        eventType: 'compliance.decision.recorded',
        actorId: 'account:account-admin',
        actorUserId: 'uid-admin',
        requestId: 'original-request',
        metadata: expect.objectContaining({
          stepUp: expect.objectContaining({
            authTime: h.session.authentication.authTime,
            strength: 'hardware_webauthn',
            enforcement: 'enforce',
            authorization: {
              actorId: 'account:account-replay',
              actorUserId: 'uid-replay',
              sessionReference: `sha256:${createHash('sha256').update('operator-session').digest('hex')}`,
              requestId: 'replay-request-970',
              correlationId: 'replay-request-970',
            },
          }),
        }),
      }),
    );
  });

  test('refuses replay before mutation when the freshness audit cannot be persisted', async () => {
    const h = await harness('compliance.create_decision');
    h.session.authentication = freshStepUp();
    jest.spyOn(h.auditLogStore, 'append').mockRejectedValueOnce(new Error('Audit unavailable'));
    expect((await h.replay()).status).toBe(503);
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.calls[0]).not.toHaveBeenCalled();
  });
});
