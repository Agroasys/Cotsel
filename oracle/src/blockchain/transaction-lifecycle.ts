import { getAddress, keccak256, Transaction, type TransactionResponse } from 'ethers';
import type {
  OracleTransactionIdentity,
  OracleTransactionOutcomeStore,
} from '../database/transaction-outcome-store';
import { Logger } from '../utils/logger';

export class OracleTransactionOutcomePendingError extends Error {
  constructor(
    public readonly transactionHash: string,
    public readonly outcome: 'broadcast_unknown' | 'confirmation_pending',
  ) {
    super('Oracle transaction outcome requires reconciliation');
    this.name = 'OracleTransactionOutcomePendingError';
  }
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code)
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_');
    return code.slice(0, 64) || 'BROADCAST_FAILED';
  }
  return 'BROADCAST_FAILED';
}

function requireIdentity(
  signedTransaction: string,
  triggerIdempotencyKey: string,
  expectedChainId: number,
  expectedDestination: string,
): OracleTransactionIdentity {
  const transaction = Transaction.from(signedTransaction);
  if (
    !transaction.hash ||
    !transaction.from ||
    !transaction.to ||
    !transaction.gasLimit ||
    transaction.nonce < 0 ||
    (transaction.type !== 0 && transaction.type !== 2)
  ) {
    throw new Error('Signed Oracle transaction is missing canonical identity');
  }
  if (Number(transaction.chainId) !== expectedChainId) {
    throw new Error('Signed Oracle transaction chain does not match configured chain');
  }
  if (getAddress(transaction.to) !== getAddress(expectedDestination)) {
    throw new Error('Signed Oracle transaction destination does not match configured escrow');
  }

  return {
    transactionHash: transaction.hash,
    triggerIdempotencyKey,
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
    intentHash: transaction.unsignedHash,
  };
}

async function persistUnknown(
  store: OracleTransactionOutcomeStore,
  transactionHash: string,
  code: string,
): Promise<void> {
  try {
    await store.markBroadcastUnknown(transactionHash, code);
  } catch (error) {
    Logger.error('Failed to persist Oracle broadcast-unknown outcome', {
      transactionHash,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function broadcastPersistedOracleTransaction(
  signedTransaction: string,
  input: {
    triggerIdempotencyKey: string;
    expectedChainId: number;
    expectedDestination: string;
  },
  store: OracleTransactionOutcomeStore,
  broadcast: (signedTransaction: string) => Promise<TransactionResponse>,
): Promise<TransactionResponse> {
  const identity = requireIdentity(
    signedTransaction,
    input.triggerIdempotencyKey,
    input.expectedChainId,
    input.expectedDestination,
  );
  await store.recordPrepared(identity);

  let response: TransactionResponse;
  try {
    response = await broadcast(signedTransaction);
  } catch (error) {
    await persistUnknown(store, identity.transactionHash, failureCode(error));
    throw new OracleTransactionOutcomePendingError(identity.transactionHash, 'broadcast_unknown');
  }

  if (response.hash.toLowerCase() !== identity.transactionHash.toLowerCase()) {
    await persistUnknown(store, identity.transactionHash, 'BROADCAST_HASH_MISMATCH');
    throw new OracleTransactionOutcomePendingError(identity.transactionHash, 'broadcast_unknown');
  }

  try {
    await store.markConfirmationPending(identity.transactionHash);
  } catch (error) {
    Logger.error('Failed to persist Oracle confirmation-pending outcome', {
      transactionHash: identity.transactionHash,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new OracleTransactionOutcomePendingError(
      identity.transactionHash,
      'confirmation_pending',
    );
  }

  return response;
}

export function isOracleTransactionOutcomePendingError(
  error: unknown,
): error is OracleTransactionOutcomePendingError {
  return error instanceof OracleTransactionOutcomePendingError;
}
