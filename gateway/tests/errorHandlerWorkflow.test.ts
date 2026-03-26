/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createInMemoryAuditLogStore } from '../src/core/auditLogStore';
import {
  GatewayErrorHandlerWorkflow,
  GatewayFailedOperationReplayer,
} from '../src/core/errorHandlerWorkflow';
import { createGatewayErrorEnvelope } from '../src/core/errorEnvelope';
import { createInMemoryFailedOperationStore } from '../src/core/failedOperationStore';
import { GatewayError } from '../src/errors';

describe('gateway error handler workflow', () => {
  test('classifies validation failures as non-replayable client contract errors', () => {
    const envelope = createGatewayErrorEnvelope(
      new GatewayError(400, 'VALIDATION_ERROR', 'Request body is invalid'),
      {
        requestId: 'req-1',
        correlationId: 'corr-1',
      },
    );

    expect(envelope).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      failureClass: 'client_contract',
      retryable: false,
      replayable: false,
      requestId: 'req-1',
      traceId: 'corr-1',
    });
  });

  test('captures infrastructure failures into a failed-operation ledger', async () => {
    const failedOperationStore = createInMemoryFailedOperationStore();
    const workflow = new GatewayErrorHandlerWorkflow(
      failedOperationStore,
      createInMemoryAuditLogStore(),
    );

    const first = await workflow.captureFailure({
      operationType: 'compliance.create_decision',
      operationKey: 'wallet:0xaa:/compliance/decisions:idem-1',
      targetService: 'gateway_compliance_write',
      route: '/api/dashboard-gateway/v1/compliance/decisions',
      method: 'POST',
      requestContext: {
        requestId: 'req-1',
        correlationId: 'corr-1',
      },
      requestPayload: { tradeId: 'TRD-1' },
      idempotencyKey: 'idem-1',
      replaySpec: {
        type: 'compliance.create_decision',
        routePath: '/api/dashboard-gateway/v1/compliance/decisions',
        payload: {
          tradeId: 'TRD-1',
          decisionType: 'KYT',
          result: 'DENY',
          reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
          provider: 'provider',
          providerRef: 'ref-1',
          subjectId: 'subject-1',
          subjectType: 'counterparty',
          riskLevel: 'high',
          overrideWindowEndsAt: null,
          correlationId: 'corr-1',
          attestation: null,
          audit: {
            reason: 'Documented operator action.',
            evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-3000' }],
            ticketRef: 'AGRO-3000',
          },
        },
      },
      error: new Error('database unavailable'),
    });
    const second = await workflow.captureFailure({
      operationType: 'compliance.create_decision',
      operationKey: 'wallet:0xaa:/compliance/decisions:idem-1',
      targetService: 'gateway_compliance_write',
      route: '/api/dashboard-gateway/v1/compliance/decisions',
      method: 'POST',
      requestContext: {
        requestId: 'req-1',
        correlationId: 'corr-1',
      },
      requestPayload: { tradeId: 'TRD-1' },
      idempotencyKey: 'idem-1',
      replaySpec: {
        type: 'compliance.create_decision',
        routePath: '/api/dashboard-gateway/v1/compliance/decisions',
        payload: {
          tradeId: 'TRD-1',
          decisionType: 'KYT',
          result: 'DENY',
          reasonCode: 'CMP_PROVIDER_UNAVAILABLE',
          provider: 'provider',
          providerRef: 'ref-1',
          subjectId: 'subject-1',
          subjectType: 'counterparty',
          riskLevel: 'high',
          overrideWindowEndsAt: null,
          correlationId: 'corr-1',
          attestation: null,
          audit: {
            reason: 'Documented operator action.',
            evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-3000' }],
            ticketRef: 'AGRO-3000',
          },
        },
      },
      error: new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Compliance store is unavailable'),
    });

    expect(first?.failedOperationId).toBeTruthy();
    expect(second?.failedOperationId).toBe(first?.failedOperationId);
    const records = await failedOperationStore.list();
    expect(records[0]).toMatchObject({
      retryCount: 2,
      failureState: 'open',
      replayEligible: true,
    });
  });

  test('replayer marks a governance failed operation as replayed after a successful retry', async () => {
    const failedOperationStore = createInMemoryFailedOperationStore();
    const recorded = await failedOperationStore.recordFailure({
      operationType: 'governance.queue_action',
      operationKey: 'wallet:0xaa:/governance/pause:idem-2',
      targetService: 'gateway_governance_queue',
      route: '/api/dashboard-gateway/v1/governance/pause',
      method: 'POST',
      requestPayload: { audit: { reason: 'Replay' } },
      requestId: 'req-2',
      correlationId: 'corr-2',
      idempotencyKey: 'idem-2',
      actorId: 'user:uid-admin',
      actorUserId: 'uid-admin',
      actorWalletAddress: '0x00000000000000000000000000000000000000aa',
      actorRole: 'admin',
      sessionReference: 'sess-ref-1',
      replayEligible: true,
      terminalErrorClass: 'infrastructure',
      terminalErrorCode: 'UPSTREAM_UNAVAILABLE',
      terminalErrorMessage: 'queue unavailable',
      failedAt: '2026-03-26T18:00:00.000Z',
      metadata: {
        replaySpec: {
          type: 'governance.queue_action',
          category: 'pause',
          contractMethod: 'pause',
          routePath: '/api/dashboard-gateway/v1/governance/pause',
          audit: {
            reason: 'Documented replay action.',
            evidenceLinks: [{ kind: 'ticket', uri: 'https://tickets.agroasys.local/AGRO-3001' }],
            ticketRef: 'AGRO-3001',
          },
        },
      },
    });

    const governanceMutationService = {
      queueAction: jest.fn().mockResolvedValue({
        actionId: 'action-1',
      }),
    } as any;
    const complianceService = {} as any;
    const settlementCallbackDispatcher = {} as any;

    const replayer = new GatewayFailedOperationReplayer(
      failedOperationStore,
      governanceMutationService,
      complianceService,
      settlementCallbackDispatcher,
    );

    const replayed = await replayer.replay(recorded.failedOperationId);
    expect(governanceMutationService.queueAction).toHaveBeenCalledTimes(1);
    expect(replayed.failureState).toBe('replayed');
    expect(replayed.lastReplayedAt).toBeTruthy();
  });
});
