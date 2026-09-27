/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';

export interface SettlementAmountSpec {
  scale: number;
  maxIntegerDigits: number;
}

// Scales match the settlement_handoffs NUMERIC columns. Integer digits are capped so that
// integer + scale digits never exceed 15 significant digits, the range in which every decimal
// round-trips exactly through an IEEE-754 double on the legacy JSON-number contract.
export const DISPLAY_AMOUNT_SPEC: SettlementAmountSpec = { scale: 2, maxIntegerDigits: 13 };
export const ASSET_AMOUNT_SPEC: SettlementAmountSpec = { scale: 6, maxIntegerDigits: 9 };

export type SettlementAmountInput = string | number;

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

function reject(field: string, reason: string, spec: SettlementAmountSpec): never {
  throw new GatewayError(
    400,
    'VALIDATION_ERROR',
    `${field} must be a non-negative decimal with at most ${spec.maxIntegerDigits} integer digits and ${spec.scale} fractional digits`,
    { field, reason },
  );
}

function decimalText(value: unknown, field: string, spec: SettlementAmountSpec): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return reject(field, 'not_finite', spec);
    }
    // Shortest round-trip form; any exponent form is outside the accepted range.
    return String(value);
  }
  return reject(field, 'invalid_type', spec);
}

/**
 * Parses a settlement amount into its canonical fixed-scale decimal string (for example
 * `1000.00`). Values are never rounded: excess fractional digits, excess magnitude, signs,
 * exponents, and non-canonical forms are rejected.
 */
export function parseSettlementAmount(
  value: unknown,
  field: string,
  spec: SettlementAmountSpec,
): string {
  const text = decimalText(value, field, spec);
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    return reject(field, 'not_canonical_decimal', spec);
  }

  const integerPart = match[1];
  const fractionPart = match[2] ?? '';
  if (fractionPart.length > spec.scale) {
    return reject(field, 'scale_exceeded', spec);
  }
  if (integerPart.length > spec.maxIntegerDigits) {
    return reject(field, 'magnitude_exceeded', spec);
  }

  return `${integerPart}.${fractionPart.padEnd(spec.scale, '0')}`;
}

export function parseOptionalSettlementAmount(
  value: unknown,
  field: string,
  spec: SettlementAmountSpec,
): string | null {
  return value === undefined || value === null ? null : parseSettlementAmount(value, field, spec);
}

/**
 * Converts a canonical amount to the JSON number used by the v1 response and callback
 * contracts. Exact because canonical amounts stay within 15 significant digits.
 */
export function settlementAmountToNumber(canonical: string): number {
  return Number(canonical);
}

export interface SettlementMonetaryIntent {
  displayCurrency: string;
  displayAmount: string;
  assetSymbol: string | null;
  assetAmount: string | null;
}

/**
 * Rejects a handoff replay whose monetary intent differs from the persisted handoff, instead of
 * silently returning the original record for a different amount.
 */
export function assertSameMonetaryIntent(
  existing: SettlementMonetaryIntent,
  incoming: SettlementMonetaryIntent,
): void {
  const mismatched = (Object.keys(existing) as Array<keyof SettlementMonetaryIntent>).filter(
    (field) => existing[field] !== incoming[field],
  );
  if (mismatched.length > 0) {
    throw new GatewayError(
      409,
      'CONFLICT',
      'Settlement handoff already exists with a different monetary intent',
      { reason: 'handoff_monetary_intent_mismatch', fields: mismatched },
    );
  }
}
