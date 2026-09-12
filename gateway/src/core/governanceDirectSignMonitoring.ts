/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, isAddress } from 'ethers';
import type { AuditLogEntry } from './auditLogStore';
import type {
  GovernanceActionRecord,
  GovernanceMonitoringState,
  GovernancePreparedSigningPayload,
} from './governanceStore';
import type {
  GovernanceObservedTransaction,
  GovernanceObservedTransactionReceipt,
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

export function confirmationsFromHead(
  receipt: GovernanceObservedTransactionReceipt | null,
  headBlockNumber: number | null,
): number | null {
  if (!receipt?.blockNumber || headBlockNumber === null || headBlockNumber < receipt.blockNumber) {
    return null;
  }

  return headBlockNumber - receipt.blockNumber + 1;
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

export async function safeGetGovernanceReceipt(
  verifier: GovernanceTransactionVerifier,
  txHash: string,
): Promise<GovernanceObservedTransactionReceipt | null> {
  try {
    return await verifier.getTransactionReceipt(txHash);
  } catch {
    return null;
  }
}

export async function safeGetGovernanceBlockNumber(
  verifier: GovernanceTransactionVerifier,
): Promise<number | null> {
  try {
    return await verifier.getBlockNumber();
  } catch {
    return null;
  }
}

export async function resolveGovernanceConfirmationOutcome(input: {
  action: GovernanceActionRecord;
  inspectedAt: string;
  finalSignerWallet: string;
  observedBlockNumber: number | null;
  verifier: GovernanceTransactionVerifier;
  confirmationDepth: number;
  finalizationDepth: number;
}): Promise<GovernanceConfirmationOutcome> {
  const {
    action,
    inspectedAt,
    finalSignerWallet,
    observedBlockNumber,
    verifier,
    confirmationDepth,
    finalizationDepth,
  } = input;
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

  if (!action.txHash) {
    return pending;
  }

  const receipt = await safeGetGovernanceReceipt(verifier, action.txHash);
  if (!receipt) {
    return pending;
  }

  if (receipt.status === 'reverted') {
    return {
      ...pending,
      status: 'failed',
      monitoringState: 'reverted',
      blockNumber: receipt.blockNumber ?? observedBlockNumber,
      executedAt: inspectedAt,
      eventType: 'governance.action.monitoring.reverted',
      errorCode: 'TX_REVERTED',
      errorMessage: 'Observed governance transaction reverted on-chain',
    };
  }

  const headBlockNumber = await safeGetGovernanceBlockNumber(verifier);
  const confirmations = confirmationsFromHead(receipt, headBlockNumber);
  if (confirmations !== null && confirmations >= finalizationDepth) {
    return {
      ...pending,
      status: 'executed',
      monitoringState: 'finalized',
      blockNumber: receipt.blockNumber ?? observedBlockNumber,
      executedAt: inspectedAt,
      eventType: 'governance.action.monitoring.finalized',
    };
  }

  if (confirmations !== null && confirmations >= confirmationDepth) {
    return {
      ...pending,
      monitoringState: 'confirmed',
      blockNumber: receipt.blockNumber ?? observedBlockNumber,
      eventType: 'governance.action.monitoring.confirmed',
    };
  }

  return {
    ...pending,
    blockNumber: receipt.blockNumber ?? observedBlockNumber,
  };
}
