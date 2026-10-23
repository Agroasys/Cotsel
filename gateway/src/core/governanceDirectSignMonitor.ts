/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { canTransitionTransactionFinality } from '@agroasys/sdk';
import {
  GovernanceActionRecord,
  GovernanceMonitoringState,
  GovernanceVerificationState,
} from './governanceStore';
import type {
  GovernanceMonitorClaim,
  GovernanceTransitionStore,
} from './governanceTransitionStore';
import {
  GovernanceObservedTransaction,
  GovernanceTransactionVerifier,
} from './governanceMutationTypes';
import {
  assessGovernanceFinality,
  buildGovernanceMonitoringAuditEntry,
  governanceActionAgeMs,
  governanceActionFinality,
  projectGovernanceFinality,
  resolveGovernanceConfirmationOutcome,
  verifyObservedGovernanceTransaction,
  type GovernanceObservedMatch,
} from './governanceDirectSignMonitoring';

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_PENDING_VERIFICATION_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_PENDING_CONFIRMATION_STALE_AFTER_MS = 30 * 60_000;
const DEFAULT_MONITOR_LEASE_MS = 2 * 60_000;

export interface GovernanceDirectSignMonitorOptions {
  verifier: GovernanceTransactionVerifier;
  now?: () => Date;
  pollIntervalMs?: number;
  pendingVerificationStaleAfterMs?: number;
  pendingConfirmationStaleAfterMs?: number;
  monitorLeaseMs?: number;
  workerId?: string;
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
  private readonly monitorLeaseMs: number;
  private readonly workerId: string;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly transitionStore: GovernanceTransitionStore,
    private readonly verifier: GovernanceTransactionVerifier,
    options: Omit<GovernanceDirectSignMonitorOptions, 'verifier'> = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pendingVerificationStaleAfterMs =
      options.pendingVerificationStaleAfterMs ?? DEFAULT_PENDING_VERIFICATION_STALE_AFTER_MS;
    this.pendingConfirmationStaleAfterMs =
      options.pendingConfirmationStaleAfterMs ?? DEFAULT_PENDING_CONFIRMATION_STALE_AFTER_MS;
    this.monitorLeaseMs = Math.max(1_000, options.monitorLeaseMs ?? DEFAULT_MONITOR_LEASE_MS);
    this.workerId = options.workerId ?? `governance-monitor-${randomUUID()}`;
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
      const claims = await this.transitionStore.claimMonitorActions({
        workerId: this.workerId,
        claimedAt: inspectedAt,
        leaseExpiresAt: new Date(Date.parse(inspectedAt) + this.monitorLeaseMs).toISOString(),
        limit,
      });
      const actions: GovernanceActionRecord[] = [];

      for (const claim of claims) {
        const current = claim.action;
        let updated: GovernanceActionRecord | null = null;
        if (current.status === 'broadcast_pending_verification') {
          updated = await this.processPendingVerification(claim, requestId, inspectedAt);
        } else if (current.status === 'broadcast') {
          updated = await this.processPendingConfirmation(claim, requestId, inspectedAt);
        }

        if (updated) {
          actions.push(updated);
        } else {
          await this.transitionStore.releaseMonitorClaim(claim);
        }
      }

      return {
        requestId,
        inspectedAt,
        inspectedCount: claims.length,
        updatedCount: actions.length,
        actions,
      };
    } finally {
      this.running = false;
    }
  }

  private async processPendingVerification(
    claim: GovernanceMonitorClaim,
    requestId: string,
    inspectedAt: string,
  ): Promise<GovernanceActionRecord | null> {
    const action = claim.action;
    if (!action.signing) {
      return this.persistTerminalFailure(
        claim,
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
        claim,
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
        claim,
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
        claim,
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
      errorCode: action.errorCode?.startsWith('LATE_BROADCAST_')
        ? 'LATE_BROADCAST_DETECTED'
        : confirmationOutcome.errorCode,
      errorMessage: action.errorCode?.startsWith('LATE_BROADCAST_')
        ? 'Transaction was observed after the off-chain preparation policy expired'
        : confirmationOutcome.errorMessage,
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

    return this.completeTransition(claim, transitioned, auditEntry);
  }

  private async processPendingConfirmation(
    claim: GovernanceMonitorClaim,
    requestId: string,
    inspectedAt: string,
  ): Promise<GovernanceActionRecord | null> {
    const action = claim.action;
    if (!action.txHash) {
      return this.persistTerminalFailure(
        claim,
        requestId,
        inspectedAt,
        'DIRECT_SIGN_MONITOR_INVALID_ACTION',
        'Direct-sign governance action is missing a broadcast transaction hash',
        'governance.action.monitoring.verification_failed',
        action.monitoringState ?? 'pending_confirmation',
        action.verificationState ?? 'verified',
      );
    }

    const assessment = await assessGovernanceFinality(this.verifier, action);
    const projection = assessment ? projectGovernanceFinality(assessment) : null;
    if (!assessment || !projection) {
      if (governanceActionAgeMs(action, inspectedAt) < this.pendingConfirmationStaleAfterMs) {
        return null;
      }

      return this.persistStale(
        claim,
        requestId,
        inspectedAt,
        'TX_CONFIRMATION_STALE',
        `Verified governance transaction did not reach a canonical receipt before the monitoring window expired (finality: ${assessment ? `${assessment.state}/${assessment.reason}` : 'unavailable'})`,
        action.verificationState ?? 'verified',
      );
    }

    const next = { state: assessment.state, final: assessment.final };
    if (!canTransitionTransactionFinality(governanceActionFinality(action), next)) {
      return null;
    }

    const blockNumber = assessment.blockNumber ?? action.blockNumber;
    const hasChanged =
      action.status !== projection.status ||
      action.monitoringState !== projection.monitoringState ||
      action.blockNumber !== blockNumber ||
      (projection.executed && !action.executedAt);

    if (!hasChanged) {
      return null;
    }

    const updatedAction: GovernanceActionRecord = {
      ...action,
      status: projection.status,
      blockNumber,
      monitoringState: projection.monitoringState,
      verificationState: action.verificationState ?? 'verified',
      executedAt: projection.executed ? (action.executedAt ?? inspectedAt) : action.executedAt,
      errorCode: action.errorCode?.startsWith('LATE_BROADCAST_')
        ? action.errorCode
        : projection.errorCode,
      errorMessage: action.errorCode?.startsWith('LATE_BROADCAST_')
        ? action.errorMessage
        : projection.errorMessage,
    };

    const auditEntry = buildGovernanceMonitoringAuditEntry(
      action,
      requestId,
      projection.eventType,
      updatedAction.status,
      {
        newStatus: updatedAction.status,
        newMonitoringState: updatedAction.monitoringState,
        blockNumber: updatedAction.blockNumber,
        finalityModelVersion: assessment.modelVersion,
        finalityState: assessment.state,
        finalityReason: assessment.reason,
        ...(projection.errorCode
          ? { errorCode: projection.errorCode, errorMessage: projection.errorMessage }
          : {}),
      },
    );

    return this.completeTransition(claim, updatedAction, auditEntry);
  }

  private async persistTerminalFailure(
    claim: GovernanceMonitorClaim,
    requestId: string,
    inspectedAt: string,
    errorCode: string,
    errorMessage: string,
    eventType: string,
    monitoringState: GovernanceMonitoringState,
    verificationState: GovernanceVerificationState,
  ): Promise<GovernanceActionRecord | null> {
    const action = claim.action;
    const failedAction: GovernanceActionRecord = {
      ...action,
      status: 'failed',
      verificationState,
      monitoringState,
      errorCode,
      errorMessage,
      executedAt: action.executedAt,
    };

    const auditEntry = buildGovernanceMonitoringAuditEntry(action, requestId, eventType, 'failed', {
      newStatus: 'failed',
      newMonitoringState: monitoringState,
      errorCode,
      errorMessage,
    });

    return this.completeTransition(claim, failedAction, auditEntry);
  }

  private async persistStale(
    claim: GovernanceMonitorClaim,
    requestId: string,
    inspectedAt: string,
    errorCode: string,
    errorMessage: string,
    verificationState: GovernanceVerificationState,
  ): Promise<GovernanceActionRecord | null> {
    const action = claim.action;
    const staleAction: GovernanceActionRecord = {
      ...action,
      status: 'stale',
      monitoringState: 'stale',
      verificationState,
      errorCode,
      errorMessage,
      executedAt: action.executedAt,
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

    return this.completeTransition(claim, staleAction, auditEntry);
  }

  private completeTransition(
    claim: GovernanceMonitorClaim,
    transition: GovernanceActionRecord,
    auditEntry: ReturnType<typeof buildGovernanceMonitoringAuditEntry>,
  ): Promise<GovernanceActionRecord | null> {
    return this.transitionStore.completeMonitorClaim(
      claim,
      transition,
      auditEntry,
      this.now().toISOString(),
    );
  }
}
