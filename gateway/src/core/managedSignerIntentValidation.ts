/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ManagedSignerValidationError, validateManagedSignerResponse } from '@agroasys/sdk';
import type {
  ManagedSignerResponsePayload,
  ManagedSignerTransactionIntent,
  ManagedSignerValidationAuditRecord,
} from '@agroasys/sdk';
import type { TransactionRequest } from 'ethers';
import { GatewayError } from '../errors';

export type ManagedSignerRequestTransaction = Omit<
  ManagedSignerTransactionIntent,
  'requestId' | 'signerAddress'
>;

export interface ManagedSignerValidationContext {
  operation: string;
  applicationRequestId: string;
  resourceId: string;
}

export type ManagedSignerValidationRecorder = (
  record: ManagedSignerValidationAuditRecord,
  context: ManagedSignerValidationContext,
) => Promise<void> | void;

export function serializeManagedSignerTransaction(
  transaction: TransactionRequest & { nonce: number; gasLimit: bigint },
): ManagedSignerRequestTransaction {
  const type =
    transaction.type === null || transaction.type === undefined
      ? transaction.maxFeePerGas !== null && transaction.maxFeePerGas !== undefined
        ? 2
        : 0
      : Number(transaction.type);
  if (type !== 0 && type !== 2) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless managed signer only permits legacy or EIP-1559 transactions',
    );
  }

  return {
    chainId: Number(transaction.chainId),
    to: String(transaction.to),
    data: typeof transaction.data === 'string' ? transaction.data : '0x',
    value:
      transaction.value === undefined || transaction.value === null
        ? '0'
        : BigInt(transaction.value).toString(),
    nonce: transaction.nonce,
    gasLimit: transaction.gasLimit.toString(),
    type,
    ...(transaction.maxFeePerGas !== null && transaction.maxFeePerGas !== undefined
      ? { maxFeePerGasWei: BigInt(transaction.maxFeePerGas).toString() }
      : {}),
    ...(transaction.maxPriorityFeePerGas !== null && transaction.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGasWei: BigInt(transaction.maxPriorityFeePerGas).toString() }
      : {}),
    ...(transaction.gasPrice !== null && transaction.gasPrice !== undefined
      ? { gasPriceWei: BigInt(transaction.gasPrice).toString() }
      : {}),
  };
}

export async function validateManagedSignerForBroadcast(
  response: ManagedSignerResponsePayload,
  intent: ManagedSignerTransactionIntent,
  context: ManagedSignerValidationContext,
  recordValidationEvidence?: ManagedSignerValidationRecorder,
): Promise<string> {
  try {
    const evidence = validateManagedSignerResponse(response, intent);
    await recordValidationEvidence?.({ ...evidence, outcome: 'accepted' }, context);
    return response.signedTransaction as string;
  } catch (error) {
    if (!(error instanceof ManagedSignerValidationError)) throw error;

    await recordValidationEvidence?.(
      {
        requestId: error.requestId,
        intentHash: error.intentHash,
        ...(error.signedTransactionHash
          ? { signedTransactionHash: error.signedTransactionHash }
          : {}),
        signerAddress: intent.signerAddress,
        nonce: intent.nonce,
        transactionType: intent.type,
        outcome: 'rejected',
        failureReason: error.reason,
      },
      context,
    );
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      'Gasless managed signer returned a transaction outside the approved intent',
      { failureReason: error.reason },
    );
  }
}
