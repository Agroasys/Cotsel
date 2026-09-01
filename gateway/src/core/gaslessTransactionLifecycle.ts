/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, keccak256, Transaction } from 'ethers';
import type { TransactionResponse } from 'ethers';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';
import type {
  GaslessConfirmedOutcome,
  GaslessTransactionIdentity,
  GaslessTransactionOutcomeRecorder,
} from './gaslessTransactionOutcomeStore';
import { gaslessBroadcastFailureCode } from './gaslessTransactionOutcomeStore';

export interface GaslessTransactionContext {
  applicationRequestId: string;
  resourceType: GaslessTransactionIdentity['resourceType'];
  resourceId: string;
  operation: string;
  intentHash?: string;
}

export class GaslessTransactionOutcomePendingError extends GatewayError {
  constructor(
    public readonly transactionHash: string,
    public readonly outcome: 'broadcast_unknown' | 'confirmation_pending',
    message: string,
  ) {
    super(503, 'UPSTREAM_UNAVAILABLE', message, { transactionHash, outcome });
    this.name = 'GaslessTransactionOutcomePendingError';
  }
}

export class GaslessTransactionRevertedError extends GatewayError {
  constructor(
    public readonly transactionHash: string,
    public readonly blockNumber: string,
  ) {
    super(502, 'UPSTREAM_UNAVAILABLE', 'Gasless transaction reverted on-chain', {
      transactionHash,
      blockNumber,
      outcome: 'reverted',
    });
    this.name = 'GaslessTransactionRevertedError';
  }
}

function requireSignedTransactionIdentity(
  signedTransaction: string,
  context: GaslessTransactionContext,
): GaslessTransactionIdentity {
  const transaction = Transaction.from(signedTransaction);
  if (
    !transaction.hash ||
    !transaction.from ||
    !transaction.to ||
    transaction.nonce < 0 ||
    !transaction.gasLimit ||
    (transaction.type !== 0 && transaction.type !== 2)
  ) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      'Signed gasless transaction is missing canonical broadcast identity',
    );
  }

  return {
    transactionHash: transaction.hash,
    applicationRequestId: context.applicationRequestId,
    resourceType: context.resourceType,
    resourceId: context.resourceId,
    operation: context.operation,
    chainId: Number(transaction.chainId),
    signerAddress: getAddress(transaction.from),
    nonce: transaction.nonce,
    transactionType: transaction.type,
    destinationAddress: getAddress(transaction.to),
    valueWei: transaction.value.toString(),
    gasLimit: transaction.gasLimit.toString(),
    maxFeePerGasWei: transaction.maxFeePerGas?.toString() ?? null,
    maxPriorityFeePerGasWei: transaction.maxPriorityFeePerGas?.toString() ?? null,
    gasPriceWei: transaction.gasPrice?.toString() ?? null,
    calldataHash: keccak256(transaction.data || '0x'),
    intentHash: context.intentHash ?? transaction.unsignedHash,
  };
}

export async function broadcastPersistedGaslessTransaction(
  signedTransaction: string,
  context: GaslessTransactionContext,
  recorder: GaslessTransactionOutcomeRecorder,
  broadcast: (signed: string) => Promise<TransactionResponse>,
): Promise<TransactionResponse> {
  const identity = requireSignedTransactionIdentity(signedTransaction, context);
  await recorder.recordPrepared(identity);

  let response: TransactionResponse;
  try {
    response = await broadcast(signedTransaction);
  } catch (error) {
    try {
      await recorder.markBroadcastUnknown(
        identity.transactionHash,
        gaslessBroadcastFailureCode(error),
      );
    } catch (persistenceError) {
      Logger.error('Failed to persist gasless broadcast-unknown transition', {
        transactionHash: identity.transactionHash,
        error:
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
      });
    }
    throw new GaslessTransactionOutcomePendingError(
      identity.transactionHash,
      'broadcast_unknown',
      'Gasless transaction broadcast outcome requires reconciliation',
    );
  }

  if (response.hash.toLowerCase() !== identity.transactionHash.toLowerCase()) {
    const observedTransactionHash = response.hash.toLowerCase();
    try {
      await recorder.markBroadcastUnknown(
        identity.transactionHash,
        'BROADCAST_HASH_MISMATCH',
        observedTransactionHash,
      );
    } catch (persistenceError) {
      Logger.error('Failed to persist gasless provider hash mismatch', {
        transactionHash: identity.transactionHash,
        observedTransactionHash,
        error:
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
      });
    }
    throw new GaslessTransactionOutcomePendingError(
      identity.transactionHash,
      'broadcast_unknown',
      'Gasless provider returned a different transaction identity',
    );
  }

  try {
    await recorder.markConfirmationPending(identity.transactionHash);
  } catch (persistenceError) {
    Logger.error('Failed to persist gasless confirmation-pending transition', {
      transactionHash: identity.transactionHash,
      error:
        persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
    });
    throw new GaslessTransactionOutcomePendingError(
      identity.transactionHash,
      'confirmation_pending',
      'Gasless transaction confirmation requires reconciliation',
    );
  }
  return response;
}

export function isGaslessTransactionOutcomePendingError(
  error: unknown,
): error is GaslessTransactionOutcomePendingError {
  return error instanceof GaslessTransactionOutcomePendingError;
}

export function isGaslessTransactionRevertedError(
  error: unknown,
): error is GaslessTransactionRevertedError {
  return error instanceof GaslessTransactionRevertedError;
}

export async function projectPersistedGaslessTransaction<T>(
  transactionHash: string,
  project: () => Promise<T>,
): Promise<T> {
  try {
    return await project();
  } catch (error) {
    Logger.error('Failed to project a durable gasless transaction outcome', {
      transactionHash,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new GaslessTransactionOutcomePendingError(
      transactionHash,
      'confirmation_pending',
      'Gasless transaction outcome projection requires reconciliation',
    );
  }
}

export async function persistGaslessTerminalOutcome(
  recorder: GaslessTransactionOutcomeRecorder,
  transactionHash: string,
  status: 'confirmed' | 'reverted',
  outcome: GaslessConfirmedOutcome,
): Promise<void> {
  try {
    if (status === 'confirmed') await recorder.markConfirmed(transactionHash, outcome);
    else await recorder.markReverted(transactionHash, outcome);
  } catch (error) {
    Logger.error('Failed to persist terminal gasless transaction outcome', {
      transactionHash,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new GaslessTransactionOutcomePendingError(
      transactionHash,
      'confirmation_pending',
      'Gasless transaction confirmation requires reconciliation',
    );
  }
}
