/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { GatewayError } from '../errors';
import { AuditLogEntry, AuditLogStore } from '../core/auditLogStore';
import { withTimeout } from '../core/downstreamTimeout';
import {
  GovernanceActionRecord,
  GovernanceActionStatus,
  GovernanceActionStore,
} from '../core/governanceStore';
import {
  GovernanceMutationPreflightReader,
  GovernanceProposalState,
  UnpauseProposalState,
} from '../core/governanceStatusService';
import { GovernanceWriteStore } from '../core/governanceWriteStore';

export interface GovernanceExecutionResult {
  txHash: string;
  blockNumber: number;
  proposalId?: number | null;
}

export interface GovernanceChainExecutor {
  getSignerAddress(): Promise<string>;
  execute(action: GovernanceActionRecord): Promise<GovernanceExecutionResult>;
}

export interface GovernanceExecutionLock {
  runExclusive<T>(actionId: string, handler: () => Promise<T>): Promise<T>;
}

function sanitizeError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim().slice(0, 1000) || 'Unknown execution error';

  return {
    code: 'EXECUTION_FAILED',
    message: trimmed,
  };
}

function fallbackPostExecutionStatus(action: GovernanceActionRecord): GovernanceActionStatus | null {
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof GatewayError && error.details?.cause === 'timeout';
}

async function resolveProposalStatus(
  proposal: GovernanceProposalState | null,
  approvalsRequired: number,
): Promise<GovernanceActionStatus> {
  if (!proposal) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Proposal state disappeared after execution');
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

async function resolveUnpauseApprovalStatus(
  statusReader: GovernanceMutationPreflightReader,
): Promise<GovernanceActionStatus> {
  const [status, proposal] = await Promise.all([
    statusReader.getGovernanceStatus(),
    statusReader.getUnpauseProposalState(),
  ]);

  if (!status.paused && !proposal.hasActiveProposal) {
    return 'executed';
  }

  return proposal.approvalCount >= status.governanceApprovalsRequired ? 'approved' : 'pending_approvals';
}

export function createPostgresGovernanceExecutionLock(pool: Pool): GovernanceExecutionLock {
  return {
    async runExclusive(actionId, handler) {
      const client = await pool.connect();

      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [actionId]);
        return await handler();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [actionId]);
        } finally {
          client.release();
        }
      }
    },
  };
}

export function createInMemoryGovernanceExecutionLock(): GovernanceExecutionLock {
  return {
    async runExclusive(_actionId, handler) {
      return handler();
    },
  };
}

export class GovernanceExecutorService {
  constructor(
    private readonly store: GovernanceActionStore,
    private readonly writeStore: GovernanceWriteStore,
    private readonly auditLogStore: AuditLogStore,
    private readonly statusReader: GovernanceMutationPreflightReader,
    private readonly executionLock: GovernanceExecutionLock,
    private readonly chainExecutor: GovernanceChainExecutor,
    private readonly executionTimeoutMs = 45000,
  ) {}

  async executeAction(actionId: string, requestId: string, correlationId?: string | null): Promise<GovernanceActionRecord> {
    return this.executionLock.runExclusive(actionId, async () => {
      const existing = await this.store.get(actionId);
      if (!existing) {
        throw new GatewayError(404, 'NOT_FOUND', 'Governance action not found', { actionId });
      }

      if (existing.status !== 'requested') {
        return existing;
      }

      let executorWallet: string | null = null;
      try {
        executorWallet = await withTimeout(
          this.chainExecutor.getSignerAddress(),
          this.executionTimeoutMs,
          'Timed out while resolving governance executor signer',
          {
            details: {
              upstream: 'governance-executor',
              operation: 'getSignerAddress',
              actionId,
            },
          },
        );
      } catch (error) {
        return this.persistFailure(existing, requestId, correlationId, executorWallet, error);
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

      let execution: GovernanceExecutionResult;
      try {
        execution = await withTimeout(
          this.chainExecutor.execute(existing),
          this.executionTimeoutMs,
          'Timed out while executing queued governance action',
          {
            details: {
              upstream: 'governance-executor',
              operation: 'execute',
              actionId,
            },
          },
        );
      } catch (error) {
        if (isTimeoutError(error)) {
          return this.persistExecutionTimeout(existing, requestId, correlationId, executorWallet, error);
        }
        return this.persistFailure(existing, requestId, correlationId, executorWallet, error);
      }

      const persisted = await this.persistExecution(existing, execution);
      const auditEntry: AuditLogEntry = {
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
      } catch (error) {
        throw new GatewayError(500, 'INTERNAL_ERROR', 'Failed to persist executed governance action; manual reconciliation is required', {
          actionId,
          txHash: execution.txHash,
          blockNumber: execution.blockNumber,
          proposalId: execution.proposalId ?? null,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private async persistFailure(
    existing: GovernanceActionRecord,
    requestId: string,
    correlationId: string | null | undefined,
    executorWallet: string | null,
    error: unknown,
  ): Promise<GovernanceActionRecord> {
    const sanitized = sanitizeError(error);
    const failedRecord: GovernanceActionRecord = {
      ...existing,
      status: 'failed',
      errorCode: sanitized.code,
      errorMessage: sanitized.message,
      executedAt: new Date().toISOString(),
    };

    const auditEntry: AuditLogEntry = {
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

  private async persistExecutionTimeout(
    existing: GovernanceActionRecord,
    requestId: string,
    correlationId: string | null | undefined,
    executorWallet: string | null,
    error: unknown,
  ): Promise<GovernanceActionRecord> {
    const sanitized = sanitizeError(error);
    const submittedRecord: GovernanceActionRecord = {
      ...existing,
      status: 'submitted',
      errorCode: 'EXECUTION_TIMEOUT',
      errorMessage: sanitized.message,
      executedAt: new Date().toISOString(),
    };

    const auditEntry: AuditLogEntry = {
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

  private async persistExecution(
    action: GovernanceActionRecord,
    execution: GovernanceExecutionResult,
  ): Promise<GovernanceActionRecord> {
    let finalStatus: GovernanceActionStatus;
    let statusResolutionFailure: { code: string; message: string } | null = null;

    try {
      finalStatus = await this.resolvePostExecutionStatus(action, execution.proposalId ?? action.proposalId);
    } catch (error) {
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

  private async resolvePostExecutionStatus(
    action: GovernanceActionRecord,
    resolvedProposalId: number | null,
  ): Promise<GovernanceActionStatus> {
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
        return resolveProposalStatus(
          await this.statusReader.getTreasuryPayoutReceiverProposalState(resolvedProposalId ?? -1),
          status.governanceApprovalsRequired,
        );
      }
      case 'approveOracleUpdate': {
        const status = await this.statusReader.getGovernanceStatus();
        return resolveProposalStatus(
          await this.statusReader.getOracleProposalState(resolvedProposalId ?? -1),
          status.governanceApprovalsRequired,
        );
      }
      default:
        throw new GatewayError(500, 'INTERNAL_ERROR', 'Unsupported governance contract method for post-execution state resolution', {
          contractMethod: action.contractMethod,
        });
    }
  }
}
