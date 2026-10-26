/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, isAddress } from 'ethers';
import {
  classifyTransactionFinality,
  type TransactionFinalityAssessment,
  type TransactionFinalityPosition,
} from '@agroasys/sdk';
import type { AuditLogEntry } from './auditLogStore';
import type {
  GovernanceActionRecord,
  GovernanceMonitoringState,
  GovernancePreparedSigningPayload,
} from './governanceStore';
import type {
  GovernanceObservedTransaction,
  GovernanceTransactionVerifier,
} from './governanceMutationTypes';

export interface GovernanceObservedMatch {
  finalSignerWallet: string;
  blockNumber: number | null;
}

export interface GovernanceConfirmationOutcome {
  status: GovernanceActionRecord['status'];
  monitoringState: GovernanceMonitoringState;
  finalSignerWallet: string;
  verifiedAt: string;
  blockNumber: number | null;
  executedAt: string | null;
  eventType: string;
  errorCode: string | null;
  errorMessage: string | null;
}

function normalizeAddressOrNull(value: string | null | undefined): string | null {
  if (!value || !isAddress(value)) {
    return null;
  }

  return getAddress(value);
}

export function verifyObservedGovernanceTransaction(
  expectedSigning: GovernancePreparedSigningPayload,
  observed: GovernanceObservedTransaction,
): GovernanceObservedMatch {
  if (observed.chainId !== expectedSigning.chainId) {
    throw new Error(
      `Observed transaction chain ${String(observed.chainId)} does not match expected chain ${String(expectedSigning.chainId)}`,
    );
  }

  const actualTo = normalizeAddressOrNull(observed.to);
  if (!actualTo || actualTo !== expectedSigning.contractAddress) {
    throw new Error('Observed transaction target does not match the prepared governance action');
  }

  if ((observed.data ?? '').toLowerCase() !== expectedSigning.txRequest.data.toLowerCase()) {
    throw new Error('Observed transaction calldata does not match the prepared governance action');
  }

  if (observed.value !== expectedSigning.txRequest.value) {
    throw new Error('Observed transaction value does not match the prepared governance action');
  }

  if (observed.nonce !== expectedSigning.txRequest.nonce) {
    throw new Error('Observed transaction nonce does not match the prepared governance action');
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

export function governanceActionAgeMs(
  action: GovernanceActionRecord,
  referenceTime: string,
): number {
  const anchor = action.broadcastAt ?? action.createdAt;
  return Math.max(0, Date.parse(referenceTime) - Date.parse(anchor));
}

export function buildGovernanceMonitoringAuditEntry(
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

/** The chain the action was prepared for; nothing observed on another chain counts. */
export function governanceExpectedChainId(action: GovernanceActionRecord): number | null {
  const chainId =
    action.signing?.chainId ?? (action.chainId === null ? null : Number(action.chainId));
  return chainId !== null && Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null;
}

/**
 * Classifies the broadcast through the shared WP-2 finality model. A read
 * failure yields `null`: absence of evidence, never a weaker or stronger state.
 */
export async function assessGovernanceFinality(
  verifier: GovernanceTransactionVerifier,
  action: GovernanceActionRecord,
): Promise<TransactionFinalityAssessment | null> {
  const expectedChainId = governanceExpectedChainId(action);
  if (!action.txHash || expectedChainId === null) {
    return null;
  }

  try {
    const observation = await verifier.observeTransactionFinality(action.txHash);
    return classifyTransactionFinality({
      expectedChainId,
      submission: 'broadcast',
      observations: [observation],
    });
  } catch {
    return null;
  }
}

export interface GovernanceFinalityProjection {
  status: GovernanceActionRecord['status'];
  monitoringState: GovernanceMonitoringState;
  executed: boolean;
  eventType: string;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Projects a classified finality onto governance state. Only a finalized
 * success executes and only a finalized revert fails; anything without a
 * receipt in a canonical block yields `null` and leaves the action unchanged.
 */
export function projectGovernanceFinality(
  assessment: TransactionFinalityAssessment,
): GovernanceFinalityProjection | null {
  const settled = { errorCode: null, errorMessage: null };
  switch (assessment.state) {
    case 'finalized':
      return {
        ...settled,
        status: 'executed',
        monitoringState: 'finalized',
        executed: true,
        eventType: 'governance.action.monitoring.finalized',
      };
    case 'safe':
    case 'confirmed':
      return {
        ...settled,
        status: 'broadcast',
        monitoringState: 'confirmed',
        executed: false,
        eventType: 'governance.action.monitoring.confirmed',
      };
    case 'reverted':
      return assessment.final
        ? {
            status: 'failed',
            monitoringState: 'reverted',
            executed: false,
            eventType: 'governance.action.monitoring.reverted',
            errorCode: 'TX_REVERTED',
            errorMessage: 'Observed governance transaction reverted on-chain',
          }
        : {
            ...settled,
            status: 'broadcast',
            monitoringState: 'reverted',
            executed: false,
            eventType: 'governance.action.monitoring.reverted_unfinalized',
          };
    default:
      return null;
  }
}

/** The shared finality position a stored governance action claims. */
export function governanceActionFinality(
  action: Pick<GovernanceActionRecord, 'status' | 'monitoringState'>,
): TransactionFinalityPosition | null {
  switch (action.monitoringState) {
    case 'pending_confirmation':
      return { state: 'submitted', final: false };
    case 'confirmed':
      return { state: 'confirmed', final: false };
    case 'finalized':
      return { state: 'finalized', final: true };
    case 'reverted':
      return { state: 'reverted', final: action.status === 'failed' };
    case 'stale':
      return { state: 'unknown', final: false };
    default:
      return null;
  }
}

export async function resolveGovernanceConfirmationOutcome(input: {
  action: GovernanceActionRecord;
  inspectedAt: string;
  finalSignerWallet: string;
  observedBlockNumber: number | null;
  verifier: GovernanceTransactionVerifier;
}): Promise<GovernanceConfirmationOutcome> {
  const { action, inspectedAt, finalSignerWallet, observedBlockNumber, verifier } = input;
  const pending: GovernanceConfirmationOutcome = {
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

  const assessment = await assessGovernanceFinality(verifier, action);
  const projection = assessment ? projectGovernanceFinality(assessment) : null;
  if (!assessment || !projection) {
    return pending;
  }

  return {
    ...pending,
    status: projection.status,
    monitoringState: projection.monitoringState,
    blockNumber: assessment.blockNumber ?? observedBlockNumber,
    executedAt: projection.executed ? inspectedAt : null,
    eventType: projection.eventType,
    errorCode: projection.errorCode,
    errorMessage: projection.errorMessage,
  };
}
