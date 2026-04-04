"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernanceExecutorService = void 0;
exports.createPostgresGovernanceExecutionLock = createPostgresGovernanceExecutionLock;
exports.createInMemoryGovernanceExecutionLock = createInMemoryGovernanceExecutionLock;
const errors_1 = require("../errors");
const downstreamTimeout_1 = require("../core/downstreamTimeout");
const governanceStore_1 = require("../core/governanceStore");
function sanitizeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const trimmed = message.trim().slice(0, 1000) || 'Unknown execution error';
    return {
        code: 'EXECUTION_FAILED',
        message: trimmed,
    };
}
function fallbackPostExecutionStatus(action) {
    switch (action.contractMethod) {
        case 'proposeUnpause':
        case 'approveUnpause':
        case 'proposeTreasuryPayoutAddressUpdate':
        case 'approveTreasuryPayoutAddressUpdate':
        case 'proposeOracleUpdate':
        case 'approveOracleUpdate':
            return 'pending_approvals';
        default:
            return null;
    }
}
function isTimeoutError(error) {
    return error instanceof errors_1.GatewayError && error.details?.cause === 'timeout';
}
function normalizeWalletAddress(value) {
    return (value ?? '').trim().toLowerCase();
}
async function resolveProposalStatus(proposal, approvalsRequired) {
    if (!proposal) {
        throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Proposal state disappeared after execution');
    }
    if (proposal.executed) {
        return 'executed';
    }
    if (proposal.cancelled) {
        return 'cancelled';
    }
    if (proposal.expired) {
        return 'expired';
    }
    return proposal.approvalCount >= approvalsRequired ? 'approved' : 'pending_approvals';
}
async function resolveUnpauseApprovalStatus(statusReader) {
    const [status, proposal] = await Promise.all([
        statusReader.getGovernanceStatus(),
        statusReader.getUnpauseProposalState(),
    ]);
    if (!status.paused && !proposal.hasActiveProposal) {
        return 'executed';
    }
    return proposal.approvalCount >= status.governanceApprovalsRequired ? 'approved' : 'pending_approvals';
}
function createPostgresGovernanceExecutionLock(pool) {
    return {
        async runExclusive(actionId, handler) {
            const client = await pool.connect();
            try {
                await client.query('SELECT pg_advisory_lock(hashtext($1))', [actionId]);
                return await handler();
            }
            finally {
                try {
                    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [actionId]);
                }
                finally {
                    client.release();
                }
            }
        },
    };
}
function createInMemoryGovernanceExecutionLock() {
    return {
        async runExclusive(_actionId, handler) {
            return handler();
        },
    };
}
class GovernanceExecutorService {
    constructor(store, writeStore, auditLogStore, statusReader, executionLock, chainExecutor, executionTimeoutMs = 45000) {
        this.store = store;
        this.writeStore = writeStore;
        this.auditLogStore = auditLogStore;
        this.statusReader = statusReader;
        this.executionLock = executionLock;
        this.chainExecutor = chainExecutor;
        this.executionTimeoutMs = executionTimeoutMs;
    }
    async executeAction(actionId, requestId, correlationId) {
        return this.executionLock.runExclusive(actionId, async () => {
            const existing = await this.store.get(actionId);
            if (!existing) {
                throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Governance action not found', { actionId });
            }
            if (existing.status !== 'requested') {
                return existing;
            }
            if ((0, governanceStore_1.isExpiredRequestedGovernanceAction)(existing, new Date().toISOString())) {
                return this.persistStale(existing, requestId, correlationId);
            }
            let executorWallet = null;
            try {
                executorWallet = await (0, downstreamTimeout_1.withTimeout)(this.chainExecutor.getSignerAddress(), this.executionTimeoutMs, 'Timed out while resolving governance executor signer', {
                    details: {
                        upstream: 'governance-executor',
                        operation: 'getSignerAddress',
                        actionId,
                    },
                });
            }
            catch (error) {
                return this.persistFailure(existing, requestId, correlationId, executorWallet, error);
            }
            if ((0, governanceStore_1.isApprovalGovernanceContractMethod)(existing.contractMethod)) {
                const expectedApproverWallet = normalizeWalletAddress(existing.audit.actorWallet);
                const actualExecutorWallet = normalizeWalletAddress(executorWallet);
                if (!expectedApproverWallet) {
                    throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Queued approval action is missing the approver wallet');
                }
                if (expectedApproverWallet !== actualExecutorWallet) {
                    await this.auditLogStore.append({
                        eventType: 'governance.action.execution.rejected',
                        route: '/internal/executor/governance-actions/:actionId',
                        method: 'EXECUTE',
                        requestId,
                        correlationId: correlationId ?? null,
                        actorWalletAddress: executorWallet,
                        actorRole: 'executor',
                        status: existing.status,
                        metadata: {
                            actionId,
                            contractMethod: existing.contractMethod,
                            expectedApproverWallet,
                            executorWallet,
                            reasonCode: 'EXECUTOR_SIGNER_MISMATCH',
                        },
                    });
                    throw new errors_1.GatewayError(409, 'CONFLICT', 'Executor signer does not match the queued approval approver wallet', {
                        actionId,
                        contractMethod: existing.contractMethod,
                        expectedApproverWallet,
                        executorWallet,
                    });
                }
            }
            await this.auditLogStore.append({
                eventType: 'governance.action.execution.started',
                route: '/internal/executor/governance-actions/:actionId',
                method: 'EXECUTE',
                requestId,
                correlationId: correlationId ?? null,
                actorWalletAddress: executorWallet,
                actorRole: 'executor',
                status: 'started',
                metadata: {
                    actionId,
                    category: existing.category,
                    contractMethod: existing.contractMethod,
                },
            });
            let execution;
            try {
                execution = await (0, downstreamTimeout_1.withTimeout)(this.chainExecutor.execute(existing), this.executionTimeoutMs, 'Timed out while executing queued governance action', {
                    details: {
                        upstream: 'governance-executor',
                        operation: 'execute',
                        actionId,
                    },
                });
            }
            catch (error) {
                if (isTimeoutError(error)) {
                    return this.persistExecutionTimeout(existing, requestId, correlationId, executorWallet, error);
                }
                return this.persistFailure(existing, requestId, correlationId, executorWallet, error);
            }
            const persisted = await this.persistExecution(existing, execution);
            const auditEntry = {
                eventType: 'governance.action.execution.succeeded',
                route: '/internal/executor/governance-actions/:actionId',
                method: 'EXECUTE',
                requestId,
                correlationId: correlationId ?? null,
                actorWalletAddress: executorWallet,
                actorRole: 'executor',
                status: persisted.status,
                metadata: {
                    actionId,
                    txHash: persisted.txHash,
                    blockNumber: persisted.blockNumber,
                    proposalId: persisted.proposalId,
                    errorCode: persisted.errorCode,
                    errorMessage: persisted.errorMessage,
                },
            };
            try {
                return await this.writeStore.saveActionWithAudit(persisted, auditEntry);
            }
            catch (error) {
                throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Failed to persist executed governance action; manual reconciliation is required', {
                    actionId,
                    txHash: execution.txHash,
                    blockNumber: execution.blockNumber,
                    proposalId: execution.proposalId ?? null,
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        });
    }
    async persistFailure(existing, requestId, correlationId, executorWallet, error) {
        const sanitized = sanitizeError(error);
        const failedRecord = {
            ...existing,
            status: 'failed',
            errorCode: sanitized.code,
            errorMessage: sanitized.message,
            executedAt: new Date().toISOString(),
        };
        const auditEntry = {
            eventType: 'governance.action.execution.failed',
            route: '/internal/executor/governance-actions/:actionId',
            method: 'EXECUTE',
            requestId,
            correlationId: correlationId ?? null,
            actorWalletAddress: executorWallet,
            actorRole: 'executor',
            status: 'failed',
            metadata: {
                actionId: existing.actionId,
                errorCode: sanitized.code,
                errorMessage: sanitized.message,
            },
        };
        return this.writeStore.saveActionWithAudit(failedRecord, auditEntry);
    }
    async persistExecutionTimeout(existing, requestId, correlationId, executorWallet, error) {
        const sanitized = sanitizeError(error);
        const submittedRecord = {
            ...existing,
            status: 'submitted',
            errorCode: 'EXECUTION_TIMEOUT',
            errorMessage: sanitized.message,
            executedAt: new Date().toISOString(),
        };
        const auditEntry = {
            eventType: 'governance.action.execution.timeout',
            route: '/internal/executor/governance-actions/:actionId',
            method: 'EXECUTE',
            requestId,
            correlationId: correlationId ?? null,
            actorWalletAddress: executorWallet,
            actorRole: 'executor',
            status: 'submitted',
            metadata: {
                actionId: existing.actionId,
                errorCode: 'EXECUTION_TIMEOUT',
                errorMessage: sanitized.message,
                outcome: 'unknown',
            },
        };
        return this.writeStore.saveActionWithAudit(submittedRecord, auditEntry);
    }
    async persistStale(existing, requestId, correlationId) {
        const staleRecord = {
            ...existing,
            status: 'stale',
            errorCode: 'QUEUE_EXPIRED',
            errorMessage: 'Governance action expired in the queue before execution started',
            executedAt: new Date().toISOString(),
        };
        const auditEntry = {
            eventType: 'governance.action.execution.stale',
            route: '/internal/executor/governance-actions/:actionId',
            method: 'EXECUTE',
            requestId,
            correlationId: correlationId ?? null,
            actorRole: 'executor',
            status: 'stale',
            metadata: {
                actionId: existing.actionId,
                intentKey: existing.intentKey,
                expiresAt: existing.expiresAt,
                errorCode: 'QUEUE_EXPIRED',
            },
        };
        return this.writeStore.saveActionWithAudit(staleRecord, auditEntry);
    }
    async persistExecution(action, execution) {
        let finalStatus;
        let statusResolutionFailure = null;
        try {
            finalStatus = await this.resolvePostExecutionStatus(action, execution.proposalId ?? action.proposalId);
        }
        catch (error) {
            const fallbackStatus = fallbackPostExecutionStatus(action);
            if (!fallbackStatus) {
                throw error;
            }
            const sanitized = sanitizeError(error);
            finalStatus = fallbackStatus;
            statusResolutionFailure = {
                code: 'STATUS_RECONCILIATION_REQUIRED',
                message: `Executed on-chain but failed to resolve final status: ${sanitized.message}`.slice(0, 1000),
            };
        }
        return {
            ...action,
            proposalId: execution.proposalId ?? action.proposalId,
            status: finalStatus,
            txHash: execution.txHash,
            blockNumber: execution.blockNumber,
            executedAt: new Date().toISOString(),
            errorCode: statusResolutionFailure?.code ?? null,
            errorMessage: statusResolutionFailure?.message ?? null,
        };
    }
    async resolvePostExecutionStatus(action, resolvedProposalId) {
        switch (action.contractMethod) {
            case 'pause':
            case 'pauseClaims':
            case 'unpauseClaims':
            case 'claimTreasury':
            case 'disableOracleEmergency':
            case 'executeTreasuryPayoutAddressUpdate':
            case 'executeOracleUpdate':
                return 'executed';
            case 'proposeUnpause':
                return 'pending_approvals';
            case 'approveUnpause':
                return resolveUnpauseApprovalStatus(this.statusReader);
            case 'cancelUnpauseProposal':
            case 'cancelExpiredTreasuryPayoutAddressUpdateProposal':
            case 'cancelExpiredOracleUpdateProposal':
                return 'cancelled';
            case 'proposeTreasuryPayoutAddressUpdate':
            case 'proposeOracleUpdate':
                return 'pending_approvals';
            case 'approveTreasuryPayoutAddressUpdate': {
                const status = await this.statusReader.getGovernanceStatus();
                return resolveProposalStatus(await this.statusReader.getTreasuryPayoutReceiverProposalState(resolvedProposalId ?? -1), status.governanceApprovalsRequired);
            }
            case 'approveOracleUpdate': {
                const status = await this.statusReader.getGovernanceStatus();
                return resolveProposalStatus(await this.statusReader.getOracleProposalState(resolvedProposalId ?? -1), status.governanceApprovalsRequired);
            }
            default:
                throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Unsupported governance contract method for post-execution state resolution', {
                    contractMethod: action.contractMethod,
                });
        }
    }
}
exports.GovernanceExecutorService = GovernanceExecutorService;
//# sourceMappingURL=governanceExecutor.js.map