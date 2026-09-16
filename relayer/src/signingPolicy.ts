import { getAddress, isAddress } from 'ethers';
import {
  buildManagedSignerIntentHash,
  type ManagedSignerPolicyContext,
  type ManagedSignerTransactionIntent,
} from '@agroasys/sdk';
import { validateCalldataPolicy } from './calldataPolicy';
import type { RelayerConfig } from './config';
import { RelayerError } from './errors';

const OPERATIONS = [
  'create_trade',
  'open_dispute',
  'cancel_locked_timeout',
  'refund_in_transit_timeout',
  'finalize_after_dispute_window',
  'finalize_after_inspection_acceptance',
  'wallet_usdc_transfer',
] as const;

export type RelayerOperation = (typeof OPERATIONS)[number];

export interface RelayerSigningRequest {
  custodyMode: 'kms';
  operation: RelayerOperation;
  signerAddress: string;
  requestId: string;
  intentHash: string;
  transaction: Omit<ManagedSignerTransactionIntent, 'requestId' | 'signerAddress'>;
  policyContext: ManagedSignerPolicyContext;
}

function reject(message: string, statusCode = 400): never {
  throw new RelayerError(statusCode, 'SIGNING_POLICY_REJECTED', message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) reject(`${field} contains unsupported fields`);
  const missing = allowed.filter((key) => value[key] === undefined);
  if (missing.length > 0) reject(`${field} is missing required fields`);
}

function unsignedInteger(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    reject(`${field} must be an unsigned integer string`);
  }
  return BigInt(value).toString();
}

function operation(value: unknown): RelayerOperation {
  if (typeof value !== 'string' || !OPERATIONS.includes(value as RelayerOperation)) {
    reject('operation is not approved for the gasless relayer', 403);
  }
  return value as RelayerOperation;
}

function canonicalAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAddress(value)) reject(`${field} must be an EVM address`);
  return getAddress(value);
}

function validateFeePolicy(
  transaction: Record<string, unknown>,
  type: 0 | 2,
  config: RelayerConfig,
): void {
  const feePerGas =
    type === 2
      ? BigInt(unsignedInteger(transaction.maxFeePerGasWei, 'transaction.maxFeePerGasWei'))
      : BigInt(unsignedInteger(transaction.gasPriceWei, 'transaction.gasPriceWei'));
  if (type === 2) {
    const priorityFee = BigInt(
      unsignedInteger(transaction.maxPriorityFeePerGasWei, 'transaction.maxPriorityFeePerGasWei'),
    );
    if (priorityFee > feePerGas) reject('transaction priority fee exceeds its maximum fee');
  }
  if (feePerGas > config.maxFeePerGasWei) reject('transaction fee exceeds the relayer cap', 403);
  const gasLimit = BigInt(unsignedInteger(transaction.gasLimit, 'transaction.gasLimit'));
  if (gasLimit === 0n || gasLimit > config.maxGasLimit) {
    reject('transaction gas limit exceeds the relayer cap', 403);
  }
  if (gasLimit * feePerGas > config.maxNativeCostWei) {
    reject('transaction native cost exceeds the relayer cap', 403);
  }
}

export function validateSigningRequest(
  input: unknown,
  config: RelayerConfig,
  now = new Date(),
): RelayerSigningRequest {
  const request = object(input, 'body');
  exactKeys(
    request,
    [
      'custodyMode',
      'operation',
      'signerAddress',
      'requestId',
      'intentHash',
      'transaction',
      'policyContext',
    ],
    'body',
  );
  if (request.custodyMode !== 'kms') reject('custodyMode must be kms', 403);
  const approvedOperation = operation(request.operation);
  const signerAddress = canonicalAddress(request.signerAddress, 'signerAddress');
  if (signerAddress !== config.kmsExpectedAddress) reject('signerAddress is not approved', 403);
  if (
    typeof request.requestId !== 'string' ||
    !request.requestId ||
    request.requestId.length > 128 ||
    request.requestId !== request.requestId.trim()
  ) {
    reject('requestId must contain 1 to 128 characters');
  }
  if (typeof request.intentHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(request.intentHash)) {
    reject('intentHash must be a 32-byte hex value');
  }

  const transaction = object(request.transaction, 'transaction');
  const type = transaction.type;
  if (type !== 0 && type !== 2) reject('transaction.type must be 0 or 2');
  const fields = [
    'chainId',
    'to',
    'data',
    'value',
    'nonce',
    'gasLimit',
    'type',
    ...(type === 2 ? ['maxFeePerGasWei', 'maxPriorityFeePerGasWei'] : ['gasPriceWei']),
  ];
  exactKeys(transaction, fields, 'transaction');
  if (transaction.chainId !== config.chainId) reject('transaction chain is not approved', 403);
  if (!Number.isSafeInteger(transaction.nonce) || Number(transaction.nonce) < 0) {
    reject('transaction.nonce must be a non-negative safe integer');
  }
  if (unsignedInteger(transaction.value, 'transaction.value') !== '0') {
    reject('transaction value must be zero', 403);
  }
  const recipient = canonicalAddress(transaction.to, 'transaction.to');
  const expectedRecipient =
    approvedOperation === 'wallet_usdc_transfer' ? config.usdcAddress : config.escrowAddress;
  if (recipient !== expectedRecipient) reject('transaction recipient is not approved', 403);
  if (
    typeof transaction.data !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(transaction.data)
  ) {
    reject('transaction calldata must include a function selector');
  }
  const policyContext = validateCalldataPolicy(
    approvedOperation,
    transaction.data,
    request.policyContext,
    config,
    now,
  );
  validateFeePolicy(transaction, type, config);

  const approved = request as unknown as RelayerSigningRequest;
  const expectedIntentHash = buildManagedSignerIntentHash({
    requestId: approved.requestId,
    signerAddress,
    ...approved.transaction,
  });
  if (expectedIntentHash.toLowerCase() !== approved.intentHash.toLowerCase()) {
    reject('intentHash does not bind the exact transaction', 403);
  }
  return {
    ...approved,
    signerAddress,
    requestId: approved.requestId,
    intentHash: expectedIntentHash,
    policyContext,
    transaction: {
      ...approved.transaction,
      to: recipient,
      data: approved.transaction.data.toLowerCase(),
    },
  };
}
