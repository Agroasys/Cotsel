/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  getAddress,
  isAddress,
  isHexString,
  keccak256,
  Signature,
  toUtf8Bytes,
  verifyTypedData,
  ZeroAddress,
} from 'ethers';
import { GatewayError } from '../errors';
import { OPERATOR_ACTIONS, USER_ACTIONS } from './gaslessExecutionTypes';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessCreateTradePayload,
  GaslessOperatorActionExecutionInput,
  GaslessOperatorActionPayload,
  GaslessUserActionExecutionInput,
  GaslessUserActionPayload,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';

const HEX_32_PATTERN = /^0x[a-fA-F0-9]{64}$/;

function requireAddress(value: string, field: string): string {
  if (!isAddress(value) || value === ZeroAddress) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid non-zero address`, {
      field,
    });
  }
  return getAddress(value);
}

function requireUint(value: string, field: string): string {
  if (!/^\d+$/.test(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be an unsigned integer string`, {
      field,
    });
  }
  return BigInt(value).toString();
}

function requireBytes32(value: string, field: string): string {
  if (!HEX_32_PATTERN.test(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a 32-byte hex string`, {
      field,
    });
  }
  return value;
}

function requireSignature(value: string, field: string): string {
  if (!isHexString(value) || value.length < 132) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a hex signature`, { field });
  }
  return value;
}

function requireRecoveryId(value: number, field: string): number {
  if (!Number.isInteger(value) || (value !== 27 && value !== 28)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be 27 or 28`, { field });
  }
  return value;
}

export function requireGaslessChainId(value: number, expected: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'chainId must be a positive integer', {
      field: 'chainId',
    });
  }
  if (value !== expected) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'chainId does not match Cotsel runtime', {
      chainId: value,
      expectedChainId: expected,
    });
  }
  return value;
}

export function parseGaslessExpiry(value: string, maxTtlSeconds: number, now: Date): string {
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'expiresAt must be an ISO-8601 timestamp', {
      field: 'expiresAt',
    });
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'gasless execution request has expired', {
      field: 'expiresAt',
      expiresAt: expiresAt.toISOString(),
    });
  }
  if (expiresAt.getTime() > now.getTime() + maxTtlSeconds * 1000) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'expiresAt exceeds gasless request TTL', {
      field: 'expiresAt',
      maxTtlSeconds,
    });
  }
  return expiresAt.toISOString();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function createGaslessPayloadHash(
  input: GaslessCreateTradePayload | GaslessUserActionPayload | GaslessOperatorActionPayload,
): string {
  return keccak256(toUtf8Bytes(stableJson(input)));
}

export function normalizeCreateTradeInput(
  input: GaslessCreateTradeExecutionInput,
): GaslessCreateTradeExecutionInput {
  if (input.action !== 'create_trade') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'action is not supported', {
      field: 'action',
      allowed: ['create_trade'],
    });
  }
  return {
    ...input,
    handoffId: input.handoffId.trim(),
    contractAddress: requireAddress(input.contractAddress, 'contractAddress'),
    payloadHash: requireBytes32(input.payloadHash, 'payloadHash'),
    buyerAddress: requireAddress(input.buyerAddress, 'buyerAddress'),
    supplierAddress: requireAddress(input.supplierAddress, 'supplierAddress'),
    totalAmount: requireUint(input.totalAmount, 'totalAmount'),
    logisticsAmount: requireUint(input.logisticsAmount, 'logisticsAmount'),
    platformFeesAmount: requireUint(input.platformFeesAmount, 'platformFeesAmount'),
    supplierFirstTranche: requireUint(input.supplierFirstTranche, 'supplierFirstTranche'),
    supplierSecondTranche: requireUint(input.supplierSecondTranche, 'supplierSecondTranche'),
    ricardianHash: requireBytes32(input.ricardianHash, 'ricardianHash'),
    buyerAuthorization: {
      nonce: requireUint(input.buyerAuthorization.nonce, 'buyerAuthorization.nonce'),
      deadline: requireUint(input.buyerAuthorization.deadline, 'buyerAuthorization.deadline'),
      signature: requireSignature(
        input.buyerAuthorization.signature,
        'buyerAuthorization.signature',
      ),
    },
    usdcAuthorization: {
      from: requireAddress(input.usdcAuthorization.from, 'usdcAuthorization.from'),
      to: requireAddress(input.usdcAuthorization.to, 'usdcAuthorization.to'),
      value: requireUint(input.usdcAuthorization.value, 'usdcAuthorization.value'),
      validAfter: requireUint(input.usdcAuthorization.validAfter, 'usdcAuthorization.validAfter'),
      validBefore: requireUint(
        input.usdcAuthorization.validBefore,
        'usdcAuthorization.validBefore',
      ),
      nonce: requireBytes32(input.usdcAuthorization.nonce, 'usdcAuthorization.nonce'),
      v: requireRecoveryId(input.usdcAuthorization.v, 'usdcAuthorization.v'),
      r: requireBytes32(input.usdcAuthorization.r, 'usdcAuthorization.r'),
      s: requireBytes32(input.usdcAuthorization.s, 'usdcAuthorization.s'),
    },
  };
}

export function normalizeUserActionInput(
  input: GaslessUserActionExecutionInput,
): GaslessUserActionExecutionInput {
  if (!USER_ACTIONS.includes(input.action)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'action is not supported', {
      field: 'action',
      allowed: USER_ACTIONS,
    });
  }
  return {
    ...input,
    action: input.action,
    handoffId: input.handoffId.trim(),
    contractAddress: requireAddress(input.contractAddress, 'contractAddress'),
    payloadHash: requireBytes32(input.payloadHash, 'payloadHash'),
    userAddress: requireAddress(input.userAddress, 'userAddress'),
    tradeId: requireUint(input.tradeId, 'tradeId'),
    userAuthorization: {
      nonce: requireUint(input.userAuthorization.nonce, 'userAuthorization.nonce'),
      deadline: requireUint(input.userAuthorization.deadline, 'userAuthorization.deadline'),
      signature: requireSignature(input.userAuthorization.signature, 'userAuthorization.signature'),
    },
  };
}

export function normalizeOperatorActionInput(
  input: GaslessOperatorActionExecutionInput,
): GaslessOperatorActionExecutionInput {
  if (!OPERATOR_ACTIONS.includes(input.action)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'action is not supported', {
      field: 'action',
      allowed: OPERATOR_ACTIONS,
    });
  }
  return {
    ...input,
    action: input.action,
    handoffId: input.handoffId.trim(),
    contractAddress: requireAddress(input.contractAddress, 'contractAddress'),
    payloadHash: requireBytes32(input.payloadHash, 'payloadHash'),
    tradeId: requireUint(input.tradeId, 'tradeId'),
  };
}

export function normalizeWalletUsdcTransferInput(
  input: GaslessWalletUsdcTransferExecutionInput,
  expectedChainId: number,
  expectedTokenAddress: string,
  now: Date,
  maxAuthorizationTtlSeconds: number,
): GaslessWalletUsdcTransferExecutionInput {
  if (input.action !== 'wallet_usdc_transfer') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'action is not supported');
  }
  const normalized = {
    ...input,
    platformTransferId: input.platformTransferId.trim(),
    chainId: requireGaslessChainId(input.chainId, expectedChainId),
    tokenAddress: requireAddress(input.tokenAddress, 'tokenAddress'),
    authorizationDomainName: input.authorizationDomainName.trim(),
    from: requireAddress(input.from, 'from'),
    to: requireAddress(input.to, 'to'),
    value: requireUint(input.value, 'value'),
    validAfter: requireUint(input.validAfter, 'validAfter'),
    validBefore: requireUint(input.validBefore, 'validBefore'),
    nonce: requireBytes32(input.nonce, 'nonce'),
    v: requireRecoveryId(input.v, 'v'),
    r: requireBytes32(input.r, 'r'),
    s: requireBytes32(input.s, 's'),
  };
  if (!normalized.platformTransferId || normalized.platformTransferId.length > 128) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'platformTransferId must contain 1 to 128 characters',
    );
  }
  if (!normalized.authorizationDomainName || normalized.authorizationDomainName.length > 100) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'authorizationDomainName must contain 1 to 100 characters',
    );
  }
  if (normalized.tokenAddress !== getAddress(expectedTokenAddress)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'tokenAddress is not allowlisted');
  }
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  if (BigInt(normalized.value) <= 0n) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'value must be positive');
  }
  if (BigInt(normalized.validAfter) > nowSeconds || BigInt(normalized.validBefore) <= nowSeconds) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'USDC authorization is not currently valid');
  }
  if (BigInt(normalized.validBefore) > nowSeconds + BigInt(maxAuthorizationTtlSeconds)) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'USDC authorization exceeds the maximum sponsored-transfer lifetime',
    );
  }
  const signature = Signature.from({
    v: normalized.v,
    r: normalized.r,
    s: normalized.s,
  }).serialized;
  const signer = verifyTypedData(
    {
      name: normalized.authorizationDomainName,
      version: '2',
      chainId: normalized.chainId,
      verifyingContract: normalized.tokenAddress,
    },
    {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    {
      from: normalized.from,
      to: normalized.to,
      value: normalized.value,
      validAfter: normalized.validAfter,
      validBefore: normalized.validBefore,
      nonce: normalized.nonce,
    },
    signature,
  );
  if (getAddress(signer) !== normalized.from) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'USDC authorization signer does not match from',
    );
  }
  return normalized;
}
