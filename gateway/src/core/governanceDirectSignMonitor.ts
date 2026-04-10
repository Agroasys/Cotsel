/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { getAddress, isAddress } from 'ethers';
import { AuditLogEntry, AuditLogStore } from './auditLogStore';
import {
  GovernanceActionRecord,
  GovernanceActionStore,
  GovernanceMonitoringState,
  GovernancePreparedSigningPayload,
  GovernanceVerificationState,
} from './governanceStore';
import { GovernanceWriteStore } from './governanceWriteStore';
import {
  GovernanceObservedTransaction,
  GovernanceObservedTransactionReceipt,
  GovernanceTransactionVerifier,
} from './governanceMutationService';

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

interface GovernanceObservedMatch {
  finalSignerWallet: string;
  blockNumber: number | null;
}

function normalizeAddressOrNull(value: string | null | undefined): string | null {
  if (!value || !isAddress(value)) {
    return null;
  }

  return getAddress(value);
}

function verifyObservedTransaction(
  action: GovernanceActionRecord,
  expectedSigning: GovernancePreparedSigningPayload,
  observed: GovernanceObservedTransaction,
): GovernanceObservedMatch {
  const actualChainId = observed.chainId;
  if (actualChainId !== null && actualChainId !== expectedSigning.chainId) {
    throw new Error(
      `Observed transaction chain ${String(actualChainId)} does not match expected chain ${String(expectedSigning.chainId)}`,
    );
  }

  const actualTo = normalizeAddressOrNull(observed.to);
  if (!actualTo || actualTo !== expectedSigning.contractAddress) {
    throw new Error('Observed transaction target does not match the prepared governance action');
  }

  const actualData = (observed.data ?? '').toLowerCase();
  if (actualData !== expectedSigning.txRequest.data.toLowerCase()) {
    throw new Error('Observed transaction calldata does not match the prepared governance action');
  }

  const actualFrom = normalizeAddressOrNull(observed.from);
  if (!actualFrom) {
    throw new Error('Observed transaction signer could not be resolved');
  }

  if (actualFrom !== expectedSigning.signerWallet) {
    throw new Error('Observed transaction signer does not match the prepared signer wallet');
  }

  return {
    finalSignerWallet: actualFrom,
    blockNumber: observed.blockNumber ?? null,
  };
}

function confirmationsFromHead(
  receipt: GovernanceObservedTransactionReceipt | null,
  headBlockNumber: number | null,
): number | null {
  if (!receipt?.blockNumber || headBlockNumber === null || headBlockNumber < receipt.blockNumber) {
    return null;
  }

  return headBlockNumber - receipt.blockNumber + 1;
}

function actionAgeMs(action: GovernanceActionRecord, referenceTime: string): number {
  const anchor = action.broadcastAt ?? action.createdAt;
  return Math.max(0, Date.parse(referenceTime) - Date.parse(anchor));
}

function buildAuditEntry(
  action: GovernanceActionRecord,
  requestId: string,
  eventType: string,
  status: string,
  metadata: Record<string, unknown>,
): AuditLogEntry {
  return {
    eventType,
    route: '/internal/monitor/governance-direct-sign',
    method: 'MONITOR',
    requestId,
    correlationId: requestId,
    actionId: action.actionId,
    actorId: 'system:governance-direct-sign-monitor',
    actorRole: 'system',
    status,
    metadata: {
      actionId: action.actionId,
      category: action.category,
      contractMethod: action.contractMethod,
      flowType: action.flowType,
      txHash: action.txHash,
      monitoringState: action.monitoringState ?? null,
      verificationState: action.verificationState ?? null,
      ...metadata,
    },
  };
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

      const candidates = [
        ...pendingVerification.items,
        ...pendingConfirmation.items.filter((action) => action.flowType === 'direct_sign'),
      ];
      const actions: GovernanceActionRecord[] = [];

      for (const candidate of candidates) {
        const current = await this.actionStore.get(candidate.actionId);
        if (!current || current.flowType !== 'direct_sign') {
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
      if (actionAgeMs(action, inspectedAt) < this.pendingVerificationStaleAfterMs) {
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
      match = verifyObservedTransaction(action, action.signing, observed);
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

    const confirmationOutcome = await this.resolveConfirmationOutcome(
      action,
      inspectedAt,
      match.finalSignerWallet,
      match.blockNumber,
    );

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

    const auditEntry = buildAuditEntry(
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

    const receipt = await this.safeGetReceipt(action.txHash);
    if (!receipt) {
      if (actionAgeMs(action, inspectedAt) < this.pendingConfirmationStaleAfterMs) {
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

      const auditEntry = buildAuditEntry(
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

    const headBlockNumber = await this.safeGetBlockNumber();
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

    const auditEntry = buildAuditEntry(
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

  private async resolveConfirmationOutcome(
    action: GovernanceActionRecord,
    inspectedAt: string,
    finalSignerWallet: string,
    observedBlockNumber: number | null,
  ): Promise<{
    status: GovernanceActionRecord['status'];
    monitoringState: GovernanceMonitoringState;
    finalSignerWallet: string;
    verifiedAt: string;
    blockNumber: number | null;
    executedAt: string | null;
    eventType: string;
    errorCode: string | null;
    errorMessage: string | null;
  }> {
    if (!action.txHash) {
      return {
        status: 'broadcast',
        monitoringState: 'pending_confirmation',
        finalSignerWallet,
        verifiedAt: inspectedAt,
        blockNumber: observedBlockNumber,
        executedAt: null,
        eventType: 'governance.action.monitoring.verified',
        errorCode: null,
        errorMessage: null,
      };
    }

    const receipt = await this.safeGetReceipt(action.txHash);
    if (!receipt) {
      return {
        status: 'broadcast',
        monitoringState: 'pending_confirmation',
        finalSignerWallet,
        verifiedAt: inspectedAt,
        blockNumber: observedBlockNumber,
        executedAt: null,
        eventType: 'governance.action.monitoring.verified',
        errorCode: null,
        errorMessage: null,
      };
    }

    if (receipt.status === 'reverted') {
      return {
        status: 'failed',
        monitoringState: 'reverted',
        finalSignerWallet,
        verifiedAt: inspectedAt,
        blockNumber: receipt.blockNumber ?? observedBlockNumber,
        executedAt: inspectedAt,
        eventType: 'governance.action.monitoring.reverted',
        errorCode: 'TX_REVERTED',
        errorMessage: 'Observed governance transaction reverted on-chain',
      };
    }

    const headBlockNumber = await this.safeGetBlockNumber();
    const confirmations = confirmationsFromHead(receipt, headBlockNumber);
    if (confirmations !== null && confirmations >= this.finalizationDepth) {
      return {
        status: 'executed',
        monitoringState: 'finalized',
        finalSignerWallet,
        verifiedAt: inspectedAt,
        blockNumber: receipt.blockNumber ?? observedBlockNumber,
        executedAt: inspectedAt,
        eventType: 'governance.action.monitoring.finalized',
        errorCode: null,
        errorMessage: null,
      };
    }

    if (confirmations !== null && confirmations >= this.confirmationDepth) {
      return {
        status: 'broadcast',
        monitoringState: 'confirmed',
        finalSignerWallet,
        verifiedAt: inspectedAt,
        blockNumber: receipt.blockNumber ?? observedBlockNumber,
        executedAt: null,
        eventType: 'governance.action.monitoring.confirmed',
        errorCode: null,
        errorMessage: null,
      };
    }

    return {
      status: 'broadcast',
      monitoringState: 'pending_confirmation',
      finalSignerWallet,
      verifiedAt: inspectedAt,
      blockNumber: receipt.blockNumber ?? observedBlockNumber,
      executedAt: null,
      eventType: 'governance.action.monitoring.verified',
      errorCode: null,
      errorMessage: null,
    };
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

    const auditEntry = buildAuditEntry(action, requestId, eventType, 'failed', {
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

    const auditEntry = buildAuditEntry(
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

  private async safeGetReceipt(
    txHash: string,
  ): Promise<GovernanceObservedTransactionReceipt | null> {
    try {
      return await this.verifier.getTransactionReceipt(txHash);
    } catch {
      return null;
    }
  }

  private async safeGetBlockNumber(): Promise<number | null> {
    try {
      return await this.verifier.getBlockNumber();
    } catch {
      return null;
    }
  }
}
