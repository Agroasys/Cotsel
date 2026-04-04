"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayFailedOperationReplayer = exports.GatewayErrorHandlerWorkflow = void 0;
exports.shouldDeadLetterError = shouldDeadLetterError;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const errors_1 = require("../errors");
const auth_1 = require("../middleware/auth");
const errorEnvelope_1 = require("./errorEnvelope");
function toPrincipalSnapshot(principal) {
    if (!principal) {
        return undefined;
    }
    if ('gatewayRoles' in principal) {
        return {
            actorId: (0, auth_1.resolveGatewayActorKey)(principal.session),
            actorUserId: principal.session.userId,
            actorWalletAddress: principal.session.walletAddress,
            actorRole: principal.session.role,
            sessionReference: principal.sessionReference,
        };
    }
    return principal;
}
function shouldDeadLetterError(error) {
    const envelope = (0, errorEnvelope_1.createGatewayErrorEnvelope)(error);
    return envelope.failureClass === 'infrastructure' || envelope.failureClass === 'unexpected';
}
class GatewayErrorHandlerWorkflow {
    constructor(failedOperationStore, auditLogStore) {
        this.failedOperationStore = failedOperationStore;
        this.auditLogStore = auditLogStore;
    }
    async captureFailure(input) {
        const envelope = (0, errorEnvelope_1.createGatewayErrorEnvelope)(input.error, input.requestContext);
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
    async captureSettlementCallbackDeadLetter(input) {
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
                },
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
    buildClientError(failedOperation, requestContext) {
        return new errors_1.GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gateway stored the failed operation for deterministic replay', {
            failedOperationId: failedOperation.failedOperationId,
            operationType: failedOperation.operationType,
            targetService: failedOperation.targetService,
            replayEligible: failedOperation.replayEligible,
            requestId: requestContext.requestId,
            traceId: requestContext.correlationId,
        });
    }
}
exports.GatewayErrorHandlerWorkflow = GatewayErrorHandlerWorkflow;
function restorePrincipal(snapshot) {
    return {
        sessionReference: snapshot.sessionReference,
        session: {
            userId: snapshot.actorUserId ?? '',
            walletAddress: snapshot.actorWalletAddress,
            role: snapshot.actorRole,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60000,
            ...(snapshot.actorUserId ? { email: `${snapshot.actorUserId}@replay.invalid` } : {}),
        },
        gatewayRoles: ['operator:read', 'operator:write'],
        writeEnabled: true,
    };
}
class GatewayFailedOperationReplayer {
    constructor(failedOperationStore, governanceMutationService, complianceService, settlementCallbackDispatcher) {
        this.failedOperationStore = failedOperationStore;
        this.governanceMutationService = governanceMutationService;
        this.complianceService = complianceService;
        this.settlementCallbackDispatcher = settlementCallbackDispatcher;
    }
    async replay(failedOperationId) {
        const record = await this.failedOperationStore.get(failedOperationId);
        if (!record) {
            throw new Error(`Failed operation not found: ${failedOperationId}`);
        }
        if (!record.replayEligible) {
            throw new Error(`Failed operation is not replay-eligible: ${failedOperationId}`);
        }
        const replaySpec = record.metadata.replaySpec;
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
                        actorRole: record.actorRole ?? 'admin',
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
                        actorRole: record.actorRole ?? 'admin',
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
                        actorRole: record.actorRole ?? 'admin',
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
                        actorRole: record.actorRole ?? 'admin',
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
                    throw new Error(`Unsupported replay type ${replaySpec.type}`);
            }
            await this.failedOperationStore.markReplayed(failedOperationId, replayedAt, {
                replayResult: 'succeeded',
            });
        }
        catch (error) {
            const envelope = (0, errorEnvelope_1.createGatewayErrorEnvelope)(error);
            await this.failedOperationStore.markReplayFailed(failedOperationId, replayedAt, {
                terminalErrorClass: envelope.failureClass,
                terminalErrorCode: envelope.code,
                terminalErrorMessage: envelope.message,
            }, {
                replayResult: 'failed',
            });
            throw error;
        }
        return (await this.failedOperationStore.get(failedOperationId));
    }
}
exports.GatewayFailedOperationReplayer = GatewayFailedOperationReplayer;
//# sourceMappingURL=errorHandlerWorkflow.js.map