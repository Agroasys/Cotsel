/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { AuditLogStore } from './auditLogStore';
import {
  GovernanceActionRecord,
  GovernanceActionStore,
  GovernanceMonitoringState,
  GovernanceVerificationState,
} from './governanceStore';
import { GovernanceWriteStore } from './governanceWriteStore';
import {
  GovernanceObservedTransaction,
  GovernanceTransactionVerifier,
} from './governanceMutationTypes';
import {
  buildGovernanceMonitoringAuditEntry,
  confirmationsFromHead,
  governanceActionAgeMs,
  resolveGovernanceConfirmationOutcome,
  safeGetGovernanceBlockNumber,
  safeGetGovernanceReceipt,
  verifyObservedGovernanceTransaction,
  type GovernanceObservedMatch,
} from './governanceDirectSignMonitoring';

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_PENDING_VERIFICATION_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_PENDING_CONFIRMATION_STALE_AFTER_MS = 30 * 60_000;
const DEFAULT_CONFIRMATION_DEPTH = 1;
const DEFAULT_FINALIZATION_DEPTH = 5;

export interface GovernanceDirectSignMonitorOptions {
  verifier: GovernanceTransactionVerifier;
  now?: () => Date;
  pollIntervalMs?: number;
  pendingVerificationStaleAfterMs?: number;
  pendingConfirmationStaleAfterMs?: number;
  confirmationDepth?: number;
  finalizationDepth?: number;
}

export interface GovernanceDirectSignMonitoringResult {
  requestId: string;
  inspectedAt: string;
  inspectedCount: number;
  updatedCount: number;
  actions: GovernanceActionRecord[];
}

export class GovernanceDirectSignMonitor {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly pendingVerificationStaleAfterMs: number;
  private readonly pendingConfirmationStaleAfterMs: number;
  private readonly confirmationDepth: number;
  private readonly finalizationDepth: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly actionStore: GovernanceActionStore,
    private readonly writeStore: GovernanceWriteStore,
    private readonly auditLogStore: AuditLogStore,
    private readonly verifier: GovernanceTransactionVerifier,
    options: Omit<GovernanceDirectSignMonitorOptions, 'verifier'> = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pendingVerificationStaleAfterMs =
      options.pendingVerificationStaleAfterMs ?? DEFAULT_PENDING_VERIFICATION_STALE_AFTER_MS;
    this.pendingConfirmationStaleAfterMs =
      options.pendingConfirmationStaleAfterMs ?? DEFAULT_PENDING_CONFIRMATION_STALE_AFTER_MS;
    this.confirmationDepth = Math.max(1, options.confirmationDepth ?? DEFAULT_CONFIRMATION_DEPTH);
    this.finalizationDepth = Math.max(
      this.confirmationDepth,
      options.finalizationDepth ?? DEFAULT_FINALIZATION_DEPTH,
    );
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.processPendingActions();
    }, this.pollIntervalMs);

    void this.processPendingActions();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async processPendingActions(limit = 50): Promise<GovernanceDirectSignMonitoringResult> {
    const requestId = `governance-monitor-${randomUUID()}`;
    const inspectedAt = this.now().toISOString();

    if (this.running) {
      return {
        requestId,
        inspectedAt,
        inspectedCount: 0,
        updatedCount: 0,
        actions: [],
      };
    }

    this.running = true;
    try {
      const [pendingVerification, pendingConfirmation] = await Promise.all([
        this.actionStore.list({ status: 'broadcast_pending_verification', limit }),
        this.actionStore.list({ status: 'broadcast', limit }),
      ]);

      const candidates = [...pendingVerification.items, ...pendingConfirmation.items];
      const actions: GovernanceActionRecord[] = [];

      for (const candidate of candidates) {
        const current = await this.actionStore.get(candidate.actionId);
        if (!current) {
          continue;
        }

        let updated: GovernanceActionRecord | null = null;
        if (current.status === 'broadcast_pending_verification') {
          updated = await this.processPendingVerification(current, requestId, inspectedAt);
        } else if (current.status === 'broadcast') {
          updated = await this.processPendingConfirmation(current, requestId, inspectedAt);
        }

        if (updated) {
          actions.push(updated);
        }
      }

      return {
        requestId,
        inspectedAt,
        inspectedCount: candidates.length,
        updatedCount: actions.length,
        actions,
      };
    } finally {
      this.running = false;
    }
  }

  private async processPendingVerification(
    action: GovernanceActionRecord,
    requestId: string,
    inspectedAt: string,
  ): Promise<GovernanceActionRecord | null> {
    if (!action.signing) {
      return this.persistTerminalFailure(
        action,
        requestId,
        inspectedAt,
        'DIRECT_SIGN_MONITOR_INVALID_ACTION',
        'Prepared signing payload is missing from direct-sign governance action',
        'governance.action.monitoring.verification_failed',
        action.monitoringState ?? 'pending_verification',
        action.verificationState ?? 'failed',
      );
    }

    if (!action.txHash) {
      return this.persistTerminalFailure(
        action,
        requestId,
        inspectedAt,
        'DIRECT_SIGN_MONITOR_INVALID_ACTION',
        'Direct-sign governance action is missing a broadcast transaction hash',
        'governance.action.monitoring.verification_failed',
        action.monitoringState ?? 'pending_verification',
        action.verificationState ?? 'failed',
      );
    }

    let observed: GovernanceObservedTransaction | null = null;
    try {
      observed = await this.verifier.getTransaction(action.txHash);
    } catch {
      observed = null;
    }

    if (!observed) {
      if (governanceActionAgeMs(action, inspectedAt) < this.pendingVerificationStaleAfterMs) {
        return null;
      }

      return this.persistStale(
        action,
        requestId,
        inspectedAt,
        'TX_NOT_OBSERVED',
        'Broadcast transaction could not be observed on-chain before the verification window expired',
        action.verificationState ?? 'pending',
      );
    }

    let match: GovernanceObservedMatch;
    try {
      match = verifyObservedGovernanceTransaction(action.signing, observed);
    } catch (error) {
      return this.persistTerminalFailure(
        action,
        requestId,
        inspectedAt,
        'BROADCAST_VERIFICATION_FAILED',
        error instanceof Error
          ? error.message
          : 'Observed transaction does not match the prepared governance action',
        'governance.action.monitoring.verification_failed',
        'pending_verification',
        'failed',
      );
    }

    const confirmationOutcome = await resolveGovernanceConfirmationOutcome({
      action,
      inspectedAt,
      finalSignerWallet: match.finalSignerWallet,
      observedBlockNumber: match.blockNumber,
      verifier: this.verifier,
      confirmationDepth: this.confirmationDepth,
      finalizationDepth: this.finalizationDepth,
    });

    const transitioned: GovernanceActionRecord = {
      ...action,
      status: confirmationOutcome.status,
      blockNumber: confirmationOutcome.blockNumber,
      finalSignerWallet: confirmationOutcome.finalSignerWallet,
      verificationState: 'verified',
      verificationError: null,
      verifiedAt: confirmationOutcome.verifiedAt,
      monitoringState: confirmationOutcome.monitoringState,
      executedAt: confirmationOutcome.executedAt,
      errorCode: confirmationOutcome.errorCode,
      errorMessage: confirmationOutcome.errorMessage,
      audit: {
        ...action.audit,
        finalSignerWallet: confirmationOutcome.finalSignerWallet,
        finalSignerVerifiedAt: confirmationOutcome.verifiedAt,
      },
    };

    const auditEntry = buildGovernanceMonitoringAuditEntry(
      action,
      requestId,
      confirmationOutcome.eventType,
      transitioned.status,
      {
        newStatus: transitioned.status,
        newMonitoringState: transitioned.monitoringState,
        finalSignerWallet: confirmationOutcome.finalSignerWallet,
        blockNumber: confirmationOutcome.blockNumber,
        confirmedAt: confirmationOutcome.executedAt,
        verifiedAt: confirmationOutcome.verifiedAt,
        errorCode: confirmationOutcome.errorCode,
        errorMessage: confirmationOutcome.errorMessage,
      },
    );

    return this.writeStore.saveActionWithAudit(transitioned, auditEntry);
  }

  private async processPendingConfirmation(
    action: GovernanceActionRecord,
    requestId: string,
    inspectedAt: string,
  ): Promise<GovernanceActionRecord | null> {
    if (!action.txHash) {
      return this.persistTerminalFailure(
        action,
        requestId,
        inspectedAt,
        'DIRECT_SIGN_MONITOR_INVALID_ACTION',
        'Direct-sign governance action is missing a broadcast transaction hash',
        'governance.action.monitoring.verification_failed',
        action.monitoringState ?? 'pending_confirmation',
        action.verificationState ?? 'verified',
      );
    }

    const receipt = await safeGetGovernanceReceipt(this.verifier, action.txHash);
    if (!receipt) {
      if (governanceActionAgeMs(action, inspectedAt) < this.pendingConfirmationStaleAfterMs) {
        return null;
      }

      return this.persistStale(
        action,
        requestId,
        inspectedAt,
        'TX_CONFIRMATION_STALE',
        'Verified governance transaction did not reach a confirmed receipt before the monitoring window expired',
        action.verificationState ?? 'verified',
      );
    }

    if (receipt.status === 'reverted') {
      const revertedAction: GovernanceActionRecord = {
        ...action,
        status: 'failed',
        blockNumber: receipt.blockNumber ?? action.blockNumber,
        monitoringState: 'reverted',
        verificationState: action.verificationState ?? 'verified',
        errorCode: 'TX_REVERTED',
        errorMessage: 'Observed governance transaction reverted on-chain',
        executedAt: inspectedAt,
      };

      const auditEntry = buildGovernanceMonitoringAuditEntry(
        action,
        requestId,
        'governance.action.monitoring.reverted',
        'failed',
        {
          newStatus: 'failed',
          newMonitoringState: 'reverted',
          blockNumber: revertedAction.blockNumber,
        },
      );

      return this.writeStore.saveActionWithAudit(revertedAction, auditEntry);
    }

    if (receipt.status !== 'success') {
      return null;
    }

    const headBlockNumber = await safeGetGovernanceBlockNumber(this.verifier);
    const confirmations = confirmationsFromHead(receipt, headBlockNumber);
    const nextMonitoringState =
      confirmations !== null && confirmations >= this.finalizationDepth
        ? 'finalized'
        : confirmations !== null && confirmations >= this.confirmationDepth
          ? 'confirmed'
          : 'pending_confirmation';

    const nextStatus = nextMonitoringState === 'finalized' ? 'executed' : 'broadcast';
    const shouldSetExecutedAt = nextMonitoringState === 'finalized';

    const hasChanged =
      action.status !== nextStatus ||
      action.monitoringState !== nextMonitoringState ||
      action.blockNumber !== (receipt.blockNumber ?? action.blockNumber) ||
      (shouldSetExecutedAt && !action.executedAt);

    if (!hasChanged) {
      return null;
    }

    const updatedAction: GovernanceActionRecord = {
      ...action,
      status: nextStatus,
      blockNumber: receipt.blockNumber ?? action.blockNumber,
      monitoringState: nextMonitoringState,
      executedAt: shouldSetExecutedAt ? (action.executedAt ?? inspectedAt) : action.executedAt,
      errorCode: null,
      errorMessage: null,
    };

    const auditEntry = buildGovernanceMonitoringAuditEntry(
      action,
      requestId,
      nextMonitoringState === 'finalized'
        ? 'governance.action.monitoring.finalized'
        : 'governance.action.monitoring.confirmed',
      updatedAction.status,
      {
        newStatus: updatedAction.status,
        newMonitoringState: updatedAction.monitoringState,
        blockNumber: updatedAction.blockNumber,
        confirmations,
      },
    );

    return this.writeStore.saveActionWithAudit(updatedAction, auditEntry);
  }

  private async persistTerminalFailure(
    action: GovernanceActionRecord,
    requestId: string,
    inspectedAt: string,
    errorCode: string,
    errorMessage: string,
    eventType: string,
    monitoringState: GovernanceMonitoringState,
    verificationState: GovernanceVerificationState,
  ): Promise<GovernanceActionRecord> {
    const failedAction: GovernanceActionRecord = {
      ...action,
      status: 'failed',
      verificationState,
      monitoringState,
      errorCode,
      errorMessage,
      executedAt: inspectedAt,
    };

    const auditEntry = buildGovernanceMonitoringAuditEntry(action, requestId, eventType, 'failed', {
      newStatus: 'failed',
      newMonitoringState: monitoringState,
      errorCode,
      errorMessage,
    });

    return this.writeStore.saveActionWithAudit(failedAction, auditEntry);
  }

  private async persistStale(
    action: GovernanceActionRecord,
    requestId: string,
    inspectedAt: string,
    errorCode: string,
    errorMessage: string,
    verificationState: GovernanceVerificationState,
  ): Promise<GovernanceActionRecord> {
    const staleAction: GovernanceActionRecord = {
      ...action,
      status: 'stale',
      monitoringState: 'stale',
      verificationState,
      errorCode,
      errorMessage,
      executedAt: inspectedAt,
    };

    const auditEntry = buildGovernanceMonitoringAuditEntry(
      action,
      requestId,
      'governance.action.monitoring.stale',
      'stale',
      {
        newStatus: 'stale',
        newMonitoringState: 'stale',
        errorCode,
        errorMessage,
      },
    );

    return this.writeStore.saveActionWithAudit(staleAction, auditEntry);
  }
}
