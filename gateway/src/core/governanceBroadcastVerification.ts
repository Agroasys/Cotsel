/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import type { GovernanceActionRecord, GovernancePreparedSigningPayload } from './governanceStore';
import type {
  GovernanceObservedTransaction,
  GovernanceTransactionVerifier,
  GovernanceVerificationOutcome,
} from './governanceMutationTypes';
import { normalizeAddressOrNull } from './governanceSigning';

export async function verifyGovernanceBroadcast(
  verifier: GovernanceTransactionVerifier,
  existing: GovernanceActionRecord,
  txHash: string,
  assertedSignerWallet: string | null,
  expectedSigning: GovernancePreparedSigningPayload,
): Promise<GovernanceVerificationOutcome> {
  let observed: GovernanceObservedTransaction | null = null;

  try {
    observed = await verifier.getTransaction(txHash);
  } catch {
    observed = null;
  }

  if (!observed) {
    return {
      status: 'broadcast_pending_verification',
      verificationState: 'pending',
      monitoringState: 'pending_verification',
      finalSignerWallet: null,
      verificationError: null,
      verifiedAt: null,
      blockNumber: null,
    };
  }

  const actualChainId = observed.chainId;
  if (actualChainId !== expectedSigning.chainId) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Broadcast transaction chain does not match the prepared governance action',
      {
        actionId: existing.actionId,
        expectedChainId: expectedSigning.chainId,
        actualChainId,
      },
    );
  }

  const actualTo = normalizeAddressOrNull(observed.to);
  if (!actualTo || actualTo !== expectedSigning.contractAddress) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Broadcast transaction target does not match the prepared governance action',
      {
        actionId: existing.actionId,
        expectedContractAddress: expectedSigning.contractAddress,
        actualContractAddress: observed.to,
      },
    );
  }

  const actualData = (observed.data ?? '').toLowerCase();
  if (actualData !== expectedSigning.txRequest.data.toLowerCase()) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Broadcast transaction calldata does not match the prepared governance action',
      {
        actionId: existing.actionId,
      },
    );
  }

  if (observed.value !== expectedSigning.txRequest.value) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Broadcast transaction value does not match the prepared governance action',
      {
        actionId: existing.actionId,
        expectedValue: expectedSigning.txRequest.value,
        actualValue: observed.value,
      },
    );
  }

  if (observed.nonce !== expectedSigning.txRequest.nonce) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Broadcast transaction nonce does not match the prepared governance action',
      {
        actionId: existing.actionId,
        expectedNonce: expectedSigning.txRequest.nonce,
        actualNonce: observed.nonce,
      },
    );
  }

  const actualFrom = normalizeAddressOrNull(observed.from);
  if (!actualFrom) {
    throw new GatewayError(409, 'CONFLICT', 'Broadcast transaction signer could not be resolved', {
      actionId: existing.actionId,
    });
  }

  if (actualFrom !== expectedSigning.signerWallet) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Broadcast transaction signer does not match the prepared signer wallet',
      {
        actionId: existing.actionId,
        expectedSignerWallet: expectedSigning.signerWallet,
        actualSignerWallet: actualFrom,
      },
    );
  }

  if (assertedSignerWallet && actualFrom !== assertedSignerWallet) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Submitted signer wallet does not match the verified broadcast transaction signer',
      {
        actionId: existing.actionId,
        expectedSignerWallet: assertedSignerWallet,
        actualSignerWallet: actualFrom,
      },
    );
  }

  return {
    status: 'broadcast',
    verificationState: 'verified',
    monitoringState: 'pending_confirmation',
    finalSignerWallet: actualFrom,
    verificationError: null,
    verifiedAt: new Date().toISOString(),
    blockNumber: observed.blockNumber ?? null,
  };
}
