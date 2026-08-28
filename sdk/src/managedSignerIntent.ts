/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, isAddress, keccak256, toUtf8Bytes, Transaction } from 'ethers';

export interface ManagedSignerTransactionIntent {
  requestId: string;
  signerAddress: string;
  chainId: number;
  to: string;
  data: string;
  value: string;
  nonce: number;
  gasLimit: string;
  type: 0 | 2;
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  gasPriceWei?: string;
}

export interface ManagedSignerValidationEvidence {
  requestId: string;
  intentHash: string;
  signedTransactionHash: string;
  signerAddress: string;
  nonce: number;
  transactionType: number;
}

export interface ManagedSignerValidationAuditRecord {
  requestId: string;
  intentHash: string;
  signedTransactionHash?: string;
  signerAddress: string;
  nonce: number;
  transactionType: number;
  outcome: 'accepted' | 'rejected';
  failureReason?: ManagedSignerValidationFailureReason;
}

export interface ManagedSignerResponsePayload {
  requestId?: unknown;
  intentHash?: unknown;
  signerAddress?: unknown;
  signedTransaction?: unknown;
}

export type ManagedSignerValidationFailureReason =
  | 'response_request_id'
  | 'response_intent_hash'
  | 'response_signer'
  | 'response_format'
  | 'unparseable_transaction'
  | 'signature'
  | 'signer'
  | 'recipient'
  | 'chainId'
  | 'nonce'
  | 'value'
  | 'calldata'
  | 'gasLimit'
  | 'type'
  | 'accessList'
  | 'maxFeePerGas'
  | 'maxPriorityFeePerGas'
  | 'gasPrice'
  | 'transaction_hash';

export class ManagedSignerValidationError extends Error {
  constructor(
    public readonly reason: ManagedSignerValidationFailureReason,
    public readonly requestId: string,
    public readonly intentHash: string,
    public readonly signedTransactionHash?: string,
  ) {
    super(`Managed signer changed the approved transaction ${reason}`);
    this.name = 'ManagedSignerValidationError';
  }
}

function fail(
  reason: ManagedSignerValidationFailureReason,
  requestId: string,
  intentHash: string,
  signedTransactionHash?: string,
): never {
  throw new ManagedSignerValidationError(reason, requestId, intentHash, signedTransactionHash);
}

function canonicalAddress(value: string, field: string): string {
  if (!isAddress(value)) {
    throw new Error(`Managed signer ${field} must be an EVM address`);
  }
  return getAddress(value);
}

function canonicalUint(value: string, field: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Managed signer ${field} must be an unsigned integer string`);
  }
  return BigInt(value).toString();
}

function canonicalIntent(intent: ManagedSignerTransactionIntent): ManagedSignerTransactionIntent {
  const requestId = intent.requestId.trim();
  if (!requestId || requestId.length > 128) {
    throw new Error('Managed signer requestId must contain 1 to 128 characters');
  }
  if (!Number.isSafeInteger(intent.chainId) || intent.chainId < 1) {
    throw new Error('Managed signer chainId must be a positive integer');
  }
  if (!Number.isSafeInteger(intent.nonce) || intent.nonce < 0) {
    throw new Error('Managed signer nonce must be a non-negative integer');
  }
  if (intent.type !== 0 && intent.type !== 2) {
    throw new Error('Managed signer transaction type must be 0 or 2');
  }
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(intent.data)) {
    throw new Error('Managed signer calldata must be canonical hex bytes');
  }

  const normalized: ManagedSignerTransactionIntent = {
    requestId,
    signerAddress: canonicalAddress(intent.signerAddress, 'signerAddress'),
    chainId: intent.chainId,
    to: canonicalAddress(intent.to, 'recipient'),
    data: intent.data.toLowerCase(),
    value: canonicalUint(intent.value, 'value'),
    nonce: intent.nonce,
    gasLimit: canonicalUint(intent.gasLimit, 'gasLimit'),
    type: intent.type,
  };

  if (intent.type === 2) {
    if (intent.gasPriceWei !== undefined) {
      throw new Error('Managed signer EIP-1559 intent cannot set gasPriceWei');
    }
    normalized.maxFeePerGasWei = canonicalUint(intent.maxFeePerGasWei ?? '', 'maxFeePerGasWei');
    normalized.maxPriorityFeePerGasWei = canonicalUint(
      intent.maxPriorityFeePerGasWei ?? '',
      'maxPriorityFeePerGasWei',
    );
  } else {
    if (intent.maxFeePerGasWei !== undefined || intent.maxPriorityFeePerGasWei !== undefined) {
      throw new Error('Managed signer legacy intent cannot set EIP-1559 fee fields');
    }
    normalized.gasPriceWei = canonicalUint(intent.gasPriceWei ?? '', 'gasPriceWei');
  }

  return normalized;
}

export function buildManagedSignerIntentHash(intent: ManagedSignerTransactionIntent): string {
  return keccak256(toUtf8Bytes(JSON.stringify(canonicalIntent(intent))));
}

export function validateManagedSignerResponse(
  response: ManagedSignerResponsePayload,
  intent: ManagedSignerTransactionIntent,
): ManagedSignerValidationEvidence {
  const expected = canonicalIntent(intent);
  const intentHash = buildManagedSignerIntentHash(expected);
  const signedTransaction =
    typeof response.signedTransaction === 'string' &&
    /^0x(?:[0-9a-fA-F]{2})+$/.test(response.signedTransaction)
      ? response.signedTransaction
      : undefined;
  const signedTransactionHash = signedTransaction ? keccak256(signedTransaction) : undefined;

  if (response.requestId !== expected.requestId) {
    fail('response_request_id', expected.requestId, intentHash, signedTransactionHash);
  }
  if (response.intentHash !== intentHash) {
    fail('response_intent_hash', expected.requestId, intentHash, signedTransactionHash);
  }
  if (
    typeof response.signerAddress !== 'string' ||
    !isAddress(response.signerAddress) ||
    getAddress(response.signerAddress) !== expected.signerAddress
  ) {
    fail('response_signer', expected.requestId, intentHash, signedTransactionHash);
  }
  if (!signedTransaction) {
    fail('response_format', expected.requestId, intentHash);
  }

  return validateManagedSignerTransaction(signedTransaction, expected);
}

export function validateManagedSignerTransaction(
  signedTransaction: string,
  intent: ManagedSignerTransactionIntent,
): ManagedSignerValidationEvidence {
  const expected = canonicalIntent(intent);
  const intentHash = buildManagedSignerIntentHash(expected);
  let signedTransactionHash: string | undefined;
  try {
    signedTransactionHash = keccak256(signedTransaction);
  } catch {
    // The caller receives only a reason and the approved intent hash. Raw signer
    // output is deliberately excluded from errors and audit evidence.
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.from(signedTransaction);
  } catch {
    fail('unparseable_transaction', expected.requestId, intentHash, signedTransactionHash);
  }
  if (!signedTransactionHash) {
    fail('transaction_hash', expected.requestId, intentHash);
  }

  if (!transaction.signature || !transaction.from) {
    fail('signature', expected.requestId, intentHash, signedTransactionHash);
  }
  if (canonicalAddress(transaction.from, 'returned signer') !== expected.signerAddress) {
    fail('signer', expected.requestId, intentHash, signedTransactionHash);
  }
  if (!transaction.to || canonicalAddress(transaction.to, 'returned recipient') !== expected.to) {
    fail('recipient', expected.requestId, intentHash, signedTransactionHash);
  }
  if (Number(transaction.chainId) !== expected.chainId) {
    fail('chainId', expected.requestId, intentHash, signedTransactionHash);
  }
  if (transaction.nonce !== expected.nonce) {
    fail('nonce', expected.requestId, intentHash, signedTransactionHash);
  }
  if (transaction.value.toString() !== expected.value) {
    fail('value', expected.requestId, intentHash, signedTransactionHash);
  }
  if (transaction.data.toLowerCase() !== expected.data) {
    fail('calldata', expected.requestId, intentHash, signedTransactionHash);
  }
  if (transaction.gasLimit.toString() !== expected.gasLimit) {
    fail('gasLimit', expected.requestId, intentHash, signedTransactionHash);
  }
  if (transaction.type !== expected.type) {
    fail('type', expected.requestId, intentHash, signedTransactionHash);
  }
  if ((transaction.accessList?.length ?? 0) !== 0) {
    fail('accessList', expected.requestId, intentHash, signedTransactionHash);
  }

  if (expected.type === 2) {
    if (transaction.maxFeePerGas?.toString() !== expected.maxFeePerGasWei) {
      fail('maxFeePerGas', expected.requestId, intentHash, signedTransactionHash);
    }
    if (transaction.maxPriorityFeePerGas?.toString() !== expected.maxPriorityFeePerGasWei) {
      fail('maxPriorityFeePerGas', expected.requestId, intentHash, signedTransactionHash);
    }
    if (transaction.gasPrice !== null) {
      fail('gasPrice', expected.requestId, intentHash, signedTransactionHash);
    }
  } else {
    if (transaction.gasPrice?.toString() !== expected.gasPriceWei) {
      fail('gasPrice', expected.requestId, intentHash, signedTransactionHash);
    }
    if (transaction.maxFeePerGas !== null) {
      fail('maxFeePerGas', expected.requestId, intentHash, signedTransactionHash);
    }
    if (transaction.maxPriorityFeePerGas !== null) {
      fail('maxPriorityFeePerGas', expected.requestId, intentHash, signedTransactionHash);
    }
  }

  if (transaction.hash !== signedTransactionHash) {
    fail('transaction_hash', expected.requestId, intentHash, signedTransactionHash);
  }

  return {
    requestId: expected.requestId,
    intentHash,
    signedTransactionHash,
    signerAddress: expected.signerAddress,
    nonce: expected.nonce,
    transactionType: expected.type,
  };
}
