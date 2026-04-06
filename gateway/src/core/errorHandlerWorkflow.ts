/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { resolveGatewayActorKey, type GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import type { AuthServiceRole } from './authSessionClient';
import type { AuditLogStore } from './auditLogStore';
import { ComplianceService } from './complianceService';
import { createGatewayErrorEnvelope } from './errorEnvelope';
import type { FailedOperationRecord, FailedOperationStore } from './failedOperationStore';
import { GovernanceMutationService, type GovernanceMutationAuditInput } from './governanceMutationService';
import { SettlementCallbackDispatcher } from './settlementCallbackDispatcher';

export type ReplayableOperationType =
  | 'governance.queue_action'
  | 'compliance.create_decision'
  | 'compliance.block_oracle_progression'
  | 'compliance.resume_oracle_progression'
  | 'settlement.callback_delivery';

export interface FailedOperationPrincipalSnapshot {
  actorId: string;
  actorUserId: string | null;
  actorWalletAddress: string | null;
  actorRole: AuthServiceRole;
  sessionReference: string;
}

export interface GovernanceReplaySpec {
  type: 'governance.queue_action';
  category: Parameters<GovernanceMutationService['queueAction']>[0]['category'];
  contractMethod: string;
  routePath: string;
  proposalId?: number | null;
  targetAddress?: string | null;
  tradeId?: string | null;
  audit: GovernanceMutationAuditInput;
}

export interface ComplianceDecisionReplaySpec {
  type: 'compliance.create_decision';
  routePath: string;
  payload: Omit<Parameters<ComplianceService['createDecision']>[0], 'principal' | 'requestContext' | 'routePath' | 'idempotencyKey'>;
}

export interface ComplianceControlReplaySpec {
  type: 'compliance.block_oracle_progression' | 'compliance.resume_oracle_progression';
  routePath: string;
  payload: Omit<Parameters<ComplianceService['blockOracleProgression']>[0], 'principal' | 'requestContext' | 'routePath' | 'idempotencyKey'>;
}

export interface SettlementCallbackReplaySpec {
  type: 'settlement.callback_delivery';
  deliveryId: string;
  handoffId: string;
  eventId: string;
  targetUrl: string;
}

export type FailedOperationReplaySpec =
  | GovernanceReplaySpec
  | ComplianceDecisionReplaySpec
  | ComplianceControlReplaySpec
  | SettlementCallbackReplaySpec;

export interface FailedOperationCaptureInput {
  operationType: ReplayableOperationType;
  operationKey: string;
  targetService: string;
  route: string;
  method: string;
  requestContext: Pick<RequestContext, 'requestId' | 'correlationId'>;
  requestPayload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  actionKey?: string | null;
  principal?: FailedOperationPrincipalSnapshot | GatewayPrincipal;
  replaySpec: FailedOperationReplaySpec;
  error: unknown;
}

function toPrincipalSnapshot(
  principal: FailedOperationPrincipalSnapshot | GatewayPrincipal | undefined,
): FailedOperationPrincipalSnapshot | undefined {
  if (!principal) {
    return undefined;
  }

  if ('gatewayRoles' in principal) {
    return {
      actorId: resolveGatewayActorKey(principal.session),
      actorUserId: principal.session.userId,
      actorWalletAddress: principal.session.walletAddress,
      actorRole: principal.session.role,
      sessionReference: principal.sessionReference,
    };
  }

  return principal;
}

export function shouldDeadLetterError(error: unknown): boolean {
  const envelope = createGatewayErrorEnvelope(error);
  return envelope.failureClass === 'infrastructure' || envelope.failureClass === 'unexpected';
}

export class GatewayErrorHandlerWorkflow {
  constructor(
    private readonly failedOperationStore: FailedOperationStore,
    private readonly auditLogStore?: AuditLogStore,
  ) {}

  async captureFailure(input: FailedOperationCaptureInput): Promise<FailedOperationRecord | null> {
    const envelope = createGatewayErrorEnvelope(input.error, input.requestContext);
    if (envelope.failureClass !== 'infrastructure' && envelope.failureClass !== 'unexpected') {
      return null;
    }

    const principal = toPrincipalSnapshot(input.principal);
    const failedOperation = await this.failedOperationStore.recordFailure({
      operationType: input.operationType,
      operationKey: input.operationKey,
      targetService: input.targetService,
      route: input.route,
      method: input.method,
      requestPayload: input.requestPayload ?? null,
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      actionKey: input.actionKey ?? null,
      actorId: principal?.actorId ?? null,
      actorUserId: principal?.actorUserId ?? null,
      actorWalletAddress: principal?.actorWalletAddress ?? null,
      actorRole: principal?.actorRole ?? null,
      sessionReference: principal?.sessionReference ?? null,
      replayEligible: true,
      terminalErrorClass: envelope.failureClass,
      terminalErrorCode: envelope.code,
      terminalErrorMessage: envelope.message,
      failedAt: new Date().toISOString(),
      metadata: {
        replaySpec: input.replaySpec,
      },
    });

    if (this.auditLogStore) {
      await this.auditLogStore.append({
        eventType: 'gateway.failed_operation.dead_lettered',
        route: input.route,
        method: input.method,
        requestId: input.requestContext.requestId,
        correlationId: input.requestContext.correlationId ?? null,
        actionId: input.actionKey ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        actorId: principal?.actorId ?? null,
        actorUserId: principal?.actorUserId ?? null,
        actorWalletAddress: principal?.actorWalletAddress ?? null,
        actorRole: principal?.actorRole ?? null,
        status: 'dead_lettered',
        metadata: {
          failedOperationId: failedOperation.failedOperationId,
          operationType: failedOperation.operationType,
          targetService: failedOperation.targetService,
          replayEligible: failedOperation.replayEligible,
        },
      });
    }

    return failedOperation;
  }

  async captureSettlementCallbackDeadLetter(input: {
    deliveryId: string;
    handoffId: string;
    eventId: string;
    targetUrl: string;
    requestId: string;
    requestPayload: Record<string, unknown>;
    responseStatus: number | null;
    errorMessage: string;
  }): Promise<FailedOperationRecord> {
    const failedOperation = await this.failedOperationStore.recordFailure({
      operationType: 'settlement.callback_delivery',
      operationKey: `delivery:${input.deliveryId}`,
      targetService: 'settlement_callback',
      route: input.targetUrl,
      method: 'POST',
      requestPayload: input.requestPayload,
      requestId: input.requestId,
      correlationId: null,
      replayEligible: true,
      terminalErrorClass: 'infrastructure',
      terminalErrorCode: input.responseStatus ? `HTTP_${input.responseStatus}` : 'UPSTREAM_UNAVAILABLE',
      terminalErrorMessage: input.errorMessage,
      failedAt: new Date().toISOString(),
      metadata: {
        replaySpec: {
          type: 'settlement.callback_delivery',
          deliveryId: input.deliveryId,
          handoffId: input.handoffId,
          eventId: input.eventId,
          targetUrl: input.targetUrl,
        } satisfies SettlementCallbackReplaySpec,
      },
    });

    if (this.auditLogStore) {
      await this.auditLogStore.append({
        eventType: 'gateway.failed_operation.dead_lettered',
        route: input.targetUrl,
        method: 'POST',
        requestId: input.requestId,
        correlationId: null,
        status: 'dead_lettered',
        metadata: {
          failedOperationId: failedOperation.failedOperationId,
          operationType: failedOperation.operationType,
          targetService: failedOperation.targetService,
          deliveryId: input.deliveryId,
          handoffId: input.handoffId,
          eventId: input.eventId,
        },
      });
    }

    return failedOperation;
  }

  buildClientError(
    failedOperation: FailedOperationRecord,
    requestContext: Pick<RequestContext, 'requestId' | 'correlationId'>,
  ): GatewayError {
    return new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gateway stored the failed operation for deterministic replay',
      {
        failedOperationId: failedOperation.failedOperationId,
        operationType: failedOperation.operationType,
        targetService: failedOperation.targetService,
        replayEligible: failedOperation.replayEligible,
        requestId: requestContext.requestId,
        traceId: requestContext.correlationId,
      },
    );
  }
}

function restorePrincipal(snapshot: FailedOperationPrincipalSnapshot): GatewayPrincipal {
  return {
    sessionReference: snapshot.sessionReference,
    session: {
      userId: snapshot.actorUserId ?? '',
      walletAddress: snapshot.actorWalletAddress,
      role: snapshot.actorRole,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ...(snapshot.actorUserId ? { email: `${snapshot.actorUserId}@replay.invalid` } : {}),
    },
    gatewayRoles: ['operator:read', 'operator:write'],
    writeEnabled: true,
  };
}

export class GatewayFailedOperationReplayer {
  constructor(
    private readonly failedOperationStore: FailedOperationStore,
    private readonly governanceMutationService: GovernanceMutationService,
    private readonly complianceService: ComplianceService,
    private readonly settlementCallbackDispatcher: SettlementCallbackDispatcher,
  ) {}

  async replay(failedOperationId: string): Promise<FailedOperationRecord> {
    const record = await this.failedOperationStore.get(failedOperationId);
    if (!record) {
      throw new Error(`Failed operation not found: ${failedOperationId}`);
    }

    if (!record.replayEligible) {
      throw new Error(`Failed operation is not replay-eligible: ${failedOperationId}`);
    }

    const replaySpec = record.metadata.replaySpec as FailedOperationReplaySpec | undefined;
    if (!replaySpec) {
      throw new Error(`Failed operation ${failedOperationId} has no replay specification`);
    }

    const replayedAt = new Date().toISOString();

    try {
      switch (replaySpec.type) {
        case 'governance.queue_action': {
          const principal = restorePrincipal({
            actorId: record.actorId || 'user:replay',
            actorUserId: record.actorUserId,
            actorWalletAddress: record.actorWalletAddress || '0x0000000000000000000000000000000000000000',
            actorRole: (record.actorRole as AuthServiceRole | null) ?? 'admin',
            sessionReference: record.sessionReference || `replay:${failedOperationId}`,
          });
          await this.governanceMutationService.queueAction({
            category: replaySpec.category,
            contractMethod: replaySpec.contractMethod,
            routePath: replaySpec.routePath,
            proposalId: replaySpec.proposalId ?? null,
            targetAddress: replaySpec.targetAddress ?? null,
            tradeId: replaySpec.tradeId ?? null,
            audit: replaySpec.audit,
            principal,
            requestContext: {
              requestId: record.requestId,
              correlationId: record.correlationId ?? record.requestId,
              startedAtMs: Date.now(),
            },
            idempotencyKey: record.idempotencyKey || record.operationKey,
          });
          break;
        }
        case 'compliance.create_decision': {
          const principal = restorePrincipal({
            actorId: record.actorId || 'user:replay',
            actorUserId: record.actorUserId,
            actorWalletAddress: record.actorWalletAddress || '0x0000000000000000000000000000000000000000',
            actorRole: (record.actorRole as AuthServiceRole | null) ?? 'admin',
            sessionReference: record.sessionReference || `replay:${failedOperationId}`,
          });
          await this.complianceService.createDecision({
            ...replaySpec.payload,
            principal,
            requestContext: {
              requestId: record.requestId,
              correlationId: record.correlationId ?? record.requestId,
              startedAtMs: Date.now(),
            },
            routePath: replaySpec.routePath,
            idempotencyKey: record.idempotencyKey || record.operationKey,
          });
          break;
        }
        case 'compliance.block_oracle_progression': {
          const principal = restorePrincipal({
            actorId: record.actorId || 'user:replay',
            actorUserId: record.actorUserId,
            actorWalletAddress: record.actorWalletAddress || '0x0000000000000000000000000000000000000000',
            actorRole: (record.actorRole as AuthServiceRole | null) ?? 'admin',
            sessionReference: record.sessionReference || `replay:${failedOperationId}`,
          });
          await this.complianceService.blockOracleProgression({
            ...replaySpec.payload,
            principal,
            requestContext: {
              requestId: record.requestId,
              correlationId: record.correlationId ?? record.requestId,
              startedAtMs: Date.now(),
            },
            routePath: replaySpec.routePath,
            idempotencyKey: record.idempotencyKey || record.operationKey,
          });
          break;
        }
        case 'compliance.resume_oracle_progression': {
          const principal = restorePrincipal({
            actorId: record.actorId || 'user:replay',
            actorUserId: record.actorUserId,
            actorWalletAddress: record.actorWalletAddress || '0x0000000000000000000000000000000000000000',
            actorRole: (record.actorRole as AuthServiceRole | null) ?? 'admin',
            sessionReference: record.sessionReference || `replay:${failedOperationId}`,
          });
          await this.complianceService.resumeOracleProgression({
            ...replaySpec.payload,
            principal,
            requestContext: {
              requestId: record.requestId,
              correlationId: record.correlationId ?? record.requestId,
              startedAtMs: Date.now(),
            },
            routePath: replaySpec.routePath,
            idempotencyKey: record.idempotencyKey || record.operationKey,
          });
          break;
        }
        case 'settlement.callback_delivery': {
          await this.settlementCallbackDispatcher.replayDeadLetterDelivery(replaySpec.deliveryId);
          break;
        }
        default:
          throw new Error(`Unsupported replay type ${(replaySpec as { type: string }).type}`);
      }

      await this.failedOperationStore.markReplayed(failedOperationId, replayedAt, {
        replayResult: 'succeeded',
      });
    } catch (error) {
      const envelope = createGatewayErrorEnvelope(error);
      await this.failedOperationStore.markReplayFailed(
        failedOperationId,
        replayedAt,
        {
          terminalErrorClass: envelope.failureClass,
          terminalErrorCode: envelope.code,
          terminalErrorMessage: envelope.message,
        },
        {
          replayResult: 'failed',
        },
      );
      throw error;
    }

    return (await this.failedOperationStore.get(failedOperationId))!;
  }
}
