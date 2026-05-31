/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  GaslessCreateTradeAuthorization,
  GaslessCreateTradeExecutionRequest,
  GaslessExecutionUsdcAuthorizationFields,
  GaslessUserAction,
  GaslessUserActionAuthorization,
  GaslessUserActionExecutionRequest,
  SponsoredAction,
  UsdcReceiveAuthorization,
} from '../types/trade';
import { ValidationError } from '../types/errors';

type GaslessCreateTradeHashable = Omit<GaslessCreateTradeExecutionRequest, 'payloadHash'>;
type GaslessUserActionHashable = Omit<GaslessUserActionExecutionRequest, 'payloadHash'>;

export interface GaslessSettlementRuntimeConfig {
  chainId: number;
  escrowAddress: string;
}

export interface GaslessCreateTradeExecutionInput {
  handoffId: string;
  expiresAt: string | Date;
  authorization: GaslessCreateTradeAuthorization;
  usdcAuthorization: UsdcReceiveAuthorization;
}

export interface GaslessUserActionExecutionInput {
  handoffId: string;
  expiresAt: string | Date;
  action: Exclude<SponsoredAction, SponsoredAction.CREATE_TRADE>;
  authorization: GaslessUserActionAuthorization;
}

export function sponsoredActionToGaslessAction(
  action: Exclude<SponsoredAction, SponsoredAction.CREATE_TRADE>,
): GaslessUserAction {
  switch (action) {
    case SponsoredAction.OPEN_DISPUTE:
      return 'open_dispute';
    case SponsoredAction.CANCEL_LOCKED_TIMEOUT:
      return 'cancel_locked_timeout';
    case SponsoredAction.REFUND_IN_TRANSIT_TIMEOUT:
      return 'refund_in_transit_timeout';
    case SponsoredAction.FINALIZE_AFTER_DISPUTE_WINDOW:
      return 'finalize_after_dispute_window';
    default:
      throw new ValidationError('Unsupported gasless user action', { action });
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function createGaslessExecutionPayloadHash(
  input: GaslessCreateTradeHashable | GaslessUserActionHashable,
): string {
  return keccak256(toUtf8Bytes(stableJson(input)));
}

function normalizeExpiry(expiresAt: string | Date): string {
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('expiresAt must be a valid ISO-8601 timestamp');
  }

  return date.toISOString();
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }

  return trimmed;
}

function stringAmount(value: bigint): string {
  return value.toString();
}

function createAuthorizationFields(authorization: {
  nonce: bigint;
  deadline: number;
  signature: string;
}) {
  return {
    nonce: stringAmount(authorization.nonce),
    deadline: String(authorization.deadline),
    signature: authorization.signature,
  };
}

function createUsdcAuthorizationFields(
  authorization: UsdcReceiveAuthorization,
): GaslessExecutionUsdcAuthorizationFields {
  return {
    from: getAddress(authorization.from),
    to: getAddress(authorization.to),
    value: stringAmount(authorization.value),
    validAfter: String(authorization.validAfter),
    validBefore: String(authorization.validBefore),
    nonce: authorization.nonce,
    v: authorization.v,
    r: authorization.r,
    s: authorization.s,
  };
}

export class GaslessSettlementRequestBuilder {
  constructor(private readonly config: GaslessSettlementRuntimeConfig) {}

  buildCreateTradeExecutionRequest(
    input: GaslessCreateTradeExecutionInput,
  ): GaslessCreateTradeExecutionRequest {
    const buyerAddress = getAddress(input.authorization.buyer);
    const supplierAddress = getAddress(input.authorization.supplier);
    const contractAddress = getAddress(this.config.escrowAddress);
    if (input.usdcAuthorization.value !== input.authorization.totalAmount) {
      throw new ValidationError('USDC authorization value must match totalAmount', {
        totalAmount: input.authorization.totalAmount.toString(),
        usdcAuthorizationValue: input.usdcAuthorization.value.toString(),
      });
    }
    if (getAddress(input.usdcAuthorization.from) !== buyerAddress) {
      throw new ValidationError('USDC authorization sender must match buyer', {
        buyerAddress,
        usdcAuthorizationFrom: input.usdcAuthorization.from,
      });
    }
    if (getAddress(input.usdcAuthorization.to) !== contractAddress) {
      throw new ValidationError('USDC authorization recipient must match escrow contract', {
        contractAddress,
        usdcAuthorizationTo: input.usdcAuthorization.to,
      });
    }

    const requestWithoutHash: GaslessCreateTradeHashable = {
      action: 'create_trade',
      handoffId: requireNonEmpty(input.handoffId, 'handoffId'),
      chainId: this.config.chainId,
      contractAddress,
      expiresAt: normalizeExpiry(input.expiresAt),
      buyerAddress,
      supplierAddress,
      totalAmount: stringAmount(input.authorization.totalAmount),
      logisticsAmount: stringAmount(input.authorization.logisticsAmount),
      platformFeesAmount: stringAmount(input.authorization.platformFeesAmount),
      supplierFirstTranche: stringAmount(input.authorization.supplierFirstTranche),
      supplierSecondTranche: stringAmount(input.authorization.supplierSecondTranche),
      ricardianHash: input.authorization.ricardianHash,
      buyerAuthorization: createAuthorizationFields(input.authorization),
      usdcAuthorization: createUsdcAuthorizationFields(input.usdcAuthorization),
    };

    return {
      ...requestWithoutHash,
      payloadHash: createGaslessExecutionPayloadHash(requestWithoutHash),
    };
  }

  buildUserActionExecutionRequest(
    input: GaslessUserActionExecutionInput,
  ): GaslessUserActionExecutionRequest {
    const requestWithoutHash: GaslessUserActionHashable = {
      action: sponsoredActionToGaslessAction(input.action),
      handoffId: requireNonEmpty(input.handoffId, 'handoffId'),
      chainId: this.config.chainId,
      contractAddress: getAddress(this.config.escrowAddress),
      expiresAt: normalizeExpiry(input.expiresAt),
      userAddress: getAddress(input.authorization.user),
      tradeId: stringAmount(input.authorization.tradeId),
      userAuthorization: createAuthorizationFields(input.authorization),
    };

    return {
      ...requestWithoutHash,
      payloadHash: createGaslessExecutionPayloadHash(requestWithoutHash),
    };
  }
}
