/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ValidationError } from '../types/errors';

/**
 * An exact amount in the asset's smallest unit (for USDC, 1 = 0.000001 USDC).
 * There is no floating-point form (#650): amounts are `bigint` in memory and
 * canonical decimal integer strings on the wire.
 */
export interface ExactAmount {
  /** Asset identifier, for example `usdc:base-sepolia`. Compared exactly. */
  readonly asset: string;
  readonly baseUnits: bigint;
}

/** Wire form of `ExactAmount`, safe to persist and hash. */
export interface SerializedExactAmount {
  asset: string;
  baseUnits: string;
}

const CANONICAL_BASE_UNITS = /^(0|[1-9][0-9]*)$/;

/**
 * Builds an `ExactAmount`. Accepts a `bigint` or a canonical decimal integer
 * string (no sign, decimal point, exponent, whitespace or leading zero). Numbers
 * are rejected even when integral, because they may already have lost precision.
 */
export function exactAmount(asset: string, baseUnits: bigint | string): ExactAmount {
  if (typeof asset !== 'string' || asset.trim().length === 0 || asset.trim() !== asset) {
    throw new ValidationError('Amount asset must be a non-empty identifier', { field: 'asset' });
  }
  let units: bigint;
  if (typeof baseUnits === 'bigint') {
    units = baseUnits;
  } else if (typeof baseUnits === 'string' && CANONICAL_BASE_UNITS.test(baseUnits)) {
    units = BigInt(baseUnits);
  } else {
    throw new ValidationError(
      'Amount must be a bigint or canonical base-unit integer string, never a number',
      { field: 'baseUnits', receivedType: typeof baseUnits },
    );
  }
  if (units < 0n) {
    throw new ValidationError('Amount must not be negative', { field: 'baseUnits' });
  }
  return Object.freeze({ asset, baseUnits: units });
}

export function isExactAmount(value: unknown): value is ExactAmount {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { asset?: unknown; baseUnits?: unknown };
  return (
    typeof candidate.asset === 'string' &&
    candidate.asset.length > 0 &&
    typeof candidate.baseUnits === 'bigint' &&
    candidate.baseUnits >= 0n
  );
}

export function exactAmountsEqual(left: ExactAmount, right: ExactAmount): boolean {
  return left.asset === right.asset && left.baseUnits === right.baseUnits;
}

export function serializeExactAmount(amount: ExactAmount): SerializedExactAmount {
  return { asset: amount.asset, baseUnits: amount.baseUnits.toString() };
}

export function parseExactAmount(value: SerializedExactAmount): ExactAmount {
  return exactAmount(value.asset, value.baseUnits);
}
