import {
  parseSettlementUserActionBinding,
  type SettlementUserActionBinding,
} from './settlementUserActionBinding';
import { parseSettlementFundedBinding, type SettlementFundedBinding } from '@agroasys/sdk';
/** SPDX-License-Identifier: Apache-2.0 */
import { getAddress } from 'ethers';
import { GatewayError } from '../errors';
import type { GaslessCreateTradeExecutionInput } from './gaslessExecutionTypes';
import { createGaslessExecutionScopeHash } from './gaslessRequestNormalization';

export type SettlementExecutionBinding =
  SettlementCreateTradeBinding | SettlementFundedBinding | SettlementUserActionBinding;
export interface SettlementCreateTradeBinding {
  scopeVersion: 'agroasys.cotsel-execution-binding.v1';
  ownerServiceId: string;
  sourceOperationId: string;
  packageId: string;
  approvalScopeFingerprint: string;
  chainId: string;
  escrowAddress: string;
  tokenAddress: string;
  buyerAddress: string;
  supplierAddress: string;
  ricardianHash: string;
  totalAmount: string;
  logisticsAmount: string;
  platformFeesAmount: string;
  supplierFirstTranche: string;
  supplierSecondTranche: string;
  expiresAt: string;
  buyerAuthorization: { nonce: string; deadline: string };
  usdcAuthorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
  executionScopeHash: string;
}

const FIELDS = [
  'scopeVersion',
  'ownerServiceId',
  'sourceOperationId',
  'packageId',
  'approvalScopeFingerprint',
  'chainId',
  'escrowAddress',
  'tokenAddress',
  'buyerAddress',
  'supplierAddress',
  'ricardianHash',
  'totalAmount',
  'logisticsAmount',
  'platformFeesAmount',
  'supplierFirstTranche',
  'supplierSecondTranche',
  'expiresAt',
  'buyerAuthorization',
  'usdcAuthorization',
  'executionScopeHash',
];
const invalid = (): never => {
  throw new GatewayError(
    400,
    'VALIDATION_ERROR',
    'A complete versioned settlement execution binding is required',
  );
};
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 255 || value.trim() !== value)
    return invalid();
  return value;
}
function integer(value: unknown): string {
  const result = text(value);
  if (!/^(0|[1-9]\d*)$/.test(result) || BigInt(result) > (1n << 256n) - 1n) return invalid();
  return result;
}
function address(value: unknown): string {
  try {
    return getAddress(text(value)).toLowerCase();
  } catch {
    return invalid();
  }
}
function hash(value: unknown): string {
  const result = text(value);
  if (!/^0x[0-9a-f]{64}$/i.test(result)) return invalid();
  return result.toLowerCase();
}

/** Service ownership comes from authenticated credentials, never from a submitted platform ID. */
export function parseSettlementExecutionBinding(
  value: unknown,
  serviceIdentity: string | null | undefined,
): SettlementExecutionBinding {
  if (!serviceIdentity)
    throw new GatewayError(403, 'FORBIDDEN', 'An authenticated owning service is required');
  if (
    value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).scopeVersion === 'agroasys.cotsel-user-action-binding.v1'
  )
    return parseSettlementUserActionBinding(value, serviceIdentity);
  if (
    value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).scopeVersion === 'agroasys.funded-settlement-binding.v1'
  ) {
    let binding: SettlementFundedBinding;
    try {
      binding = parseSettlementFundedBinding(value);
    } catch {
      return invalid();
    }
    if (binding.ownerServiceId !== serviceIdentity)
      throw new GatewayError(
        403,
        'FORBIDDEN',
        'Funded binding owner does not match authenticated service',
      );
    return binding;
  }
  const input = object(value, FIELDS);
  if (input.scopeVersion !== 'agroasys.cotsel-execution-binding.v1') return invalid();
  if (input.ownerServiceId !== undefined && input.ownerServiceId !== serviceIdentity) {
    throw new GatewayError(
      403,
      'FORBIDDEN',
      'Execution binding owner does not match authenticated service',
    );
  }
  const buyer = object(input.buyerAuthorization, ['nonce', 'deadline']);
  const usdc = object(input.usdcAuthorization, [
    'from',
    'to',
    'value',
    'validAfter',
    'validBefore',
    'nonce',
  ]);
  const expiresAt = text(input.expiresAt);
  if (!Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt)
    return invalid();
  const result: SettlementCreateTradeBinding = {
    scopeVersion: 'agroasys.cotsel-execution-binding.v1',
    ownerServiceId: serviceIdentity,
    sourceOperationId: text(input.sourceOperationId),
    packageId: text(input.packageId),
    approvalScopeFingerprint: hash(input.approvalScopeFingerprint),
    chainId: integer(input.chainId),
    escrowAddress: address(input.escrowAddress),
    tokenAddress: address(input.tokenAddress),
    buyerAddress: address(input.buyerAddress),
    supplierAddress: address(input.supplierAddress),
    ricardianHash: hash(input.ricardianHash),
    totalAmount: integer(input.totalAmount),
    logisticsAmount: integer(input.logisticsAmount),
    platformFeesAmount: integer(input.platformFeesAmount),
    supplierFirstTranche: integer(input.supplierFirstTranche),
    supplierSecondTranche: integer(input.supplierSecondTranche),
    expiresAt,
    buyerAuthorization: { nonce: integer(buyer.nonce), deadline: integer(buyer.deadline) },
    usdcAuthorization: {
      from: address(usdc.from),
      to: address(usdc.to),
      value: integer(usdc.value),
      validAfter: integer(usdc.validAfter),
      validBefore: integer(usdc.validBefore),
      nonce: hash(usdc.nonce),
    },
    executionScopeHash: hash(input.executionScopeHash),
  };
  const expiry = String(Math.floor(Date.parse(expiresAt) / 1000));
  if (
    result.chainId === '0' ||
    result.totalAmount !== result.usdcAuthorization.value ||
    result.buyerAddress !== result.usdcAuthorization.from ||
    result.escrowAddress !== result.usdcAuthorization.to ||
    result.buyerAuthorization.deadline !== expiry ||
    result.usdcAuthorization.validBefore !== expiry ||
    BigInt(result.usdcAuthorization.validAfter) >= BigInt(result.usdcAuthorization.validBefore) ||
    BigInt(result.totalAmount) !==
      BigInt(result.logisticsAmount) +
        BigInt(result.platformFeesAmount) +
        BigInt(result.supplierFirstTranche) +
        BigInt(result.supplierSecondTranche)
  )
    return invalid();
  return result;
}

export function assertExecutionMatchesTypedBinding(
  binding: SettlementExecutionBinding,
  input: GaslessCreateTradeExecutionInput,
  tokenAddress: string,
): void {
  if (binding.scopeVersion !== 'agroasys.cotsel-execution-binding.v1')
    throw new GatewayError(409, 'CONFLICT', 'Funding requires its original create-trade binding');
  const expected: SettlementCreateTradeBinding = {
    ...binding,
    chainId: String(input.chainId),
    escrowAddress: input.contractAddress.toLowerCase(),
    tokenAddress: tokenAddress.toLowerCase(),
    buyerAddress: input.buyerAddress.toLowerCase(),
    supplierAddress: input.supplierAddress.toLowerCase(),
    ricardianHash: input.ricardianHash.toLowerCase(),
    totalAmount: input.totalAmount,
    logisticsAmount: input.logisticsAmount,
    platformFeesAmount: input.platformFeesAmount,
    supplierFirstTranche: input.supplierFirstTranche,
    supplierSecondTranche: input.supplierSecondTranche,
    expiresAt: input.expiresAt,
    buyerAuthorization: {
      nonce: input.buyerAuthorization.nonce,
      deadline: input.buyerAuthorization.deadline,
    },
    usdcAuthorization: {
      from: input.usdcAuthorization.from.toLowerCase(),
      to: input.usdcAuthorization.to.toLowerCase(),
      value: input.usdcAuthorization.value,
      validAfter: input.usdcAuthorization.validAfter,
      validBefore: input.usdcAuthorization.validBefore,
      nonce: input.usdcAuthorization.nonce.toLowerCase(),
    },
    executionScopeHash: createGaslessExecutionScopeHash(input),
  };
  if (
    Object.keys(binding).some(
      (key) =>
        JSON.stringify(binding[key as keyof SettlementCreateTradeBinding]) !==
        JSON.stringify(expected[key as keyof SettlementCreateTradeBinding]),
    )
  ) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Execution differs from the immutable typed handoff binding',
    );
  }
}
