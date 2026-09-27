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
// round-trips exactly through the IEEE-754 doubles of the v1 JSON-number responses.
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
    // In-process callers only. JSON request numbers are already rounded by the parser and must be
    // validated from their raw lexeme via readTopLevelJsonNumberLexemes instead.
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

type JsonReviverWithSource = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

/**
 * Reads the exact source text of top-level JSON number members from the raw request bytes,
 * before IEEE-754 conversion can round them. Returns null when the source text is unavailable,
 * so callers fail closed on JSON numbers rather than trusting the parsed double.
 */
export function readTopLevelJsonNumberLexemes(
  rawBody: Buffer | undefined,
): ReadonlyMap<string, string> | null {
  if (!rawBody) {
    return null;
  }

  const lexemesByHolder = new Map<unknown, Map<string, string>>();
  let sourceAvailable = true;
  const reviver: JsonReviverWithSource = function (key, value, context) {
    if (typeof value === 'number') {
      if (typeof context?.source !== 'string') {
        sourceAvailable = false;
      } else {
        const lexemes = lexemesByHolder.get(this) ?? new Map<string, string>();
        lexemes.set(key, context.source);
        lexemesByHolder.set(this, lexemes);
      }
    }
    return value;
  };

  let root: unknown;
  try {
    root = JSON.parse(rawBody.toString('utf8'), reviver as Parameters<typeof JSON.parse>[1]);
  } catch {
    return null;
  }

  return sourceAvailable ? (lexemesByHolder.get(root) ?? new Map()) : null;
}

/**
 * Substitutes the raw JSON lexeme for a parsed JSON number so amount validation sees exactly
 * what the caller sent. Strings, null, and absent values pass through unchanged.
 */
export function jsonSettlementAmountInput(
  value: unknown,
  lexemes: ReadonlyMap<string, string> | null,
  field: string,
  spec: SettlementAmountSpec,
): unknown {
  if (typeof value !== 'number') {
    return value;
  }

  const lexeme = lexemes?.get(field);
  return lexeme === undefined ? reject(field, 'raw_number_unavailable', spec) : lexeme;
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
