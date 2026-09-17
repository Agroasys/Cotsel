/**
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Treasury monetary values are scaled integers in the asset's smallest unit —
 * the exact uint256 the escrow contract emitted, never a decimal or a float.
 * A canonical value is the unique shortest decimal spelling of that integer, so
 * '1000' and '01000' can never both describe the same amount and string
 * comparison stays equivalent to numeric comparison.
 */
export const CANONICAL_RAW_AMOUNT_PATTERN = /^(0|[1-9][0-9]*)$/;

/** The escrow emits uint256, so that range is the authoritative upper bound. */
export const MAX_RAW_AMOUNT = 2n ** 256n - 1n;

/** 2^256-1 is 78 digits; refuse longer input before touching BigInt. */
export const MAX_RAW_AMOUNT_DIGITS = 78;

export class NonCanonicalAmountError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`${field} is not a canonical treasury amount: ${reason}`);
    this.name = 'NonCanonicalAmountError';
    this.field = field;
  }
}

/**
 * Rejects every non-canonical spelling rather than coercing it. Coercion is how
 * an unconstrained text column silently acquires '', '1e6', '-5' or ' 100 ',
 * each of which reads as a plausible amount somewhere downstream.
 */
export function assertCanonicalRawAmount(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new NonCanonicalAmountError(field, `expected a string, received ${typeof value}`);
  }

  if (value.length === 0) {
    throw new NonCanonicalAmountError(field, 'value is empty');
  }

  if (value.length > MAX_RAW_AMOUNT_DIGITS) {
    throw new NonCanonicalAmountError(
      field,
      `value has ${value.length} digits, exceeding the ${MAX_RAW_AMOUNT_DIGITS}-digit uint256 range`,
    );
  }

  if (!CANONICAL_RAW_AMOUNT_PATTERN.test(value)) {
    throw new NonCanonicalAmountError(
      field,
      'value must be unsigned decimal digits with no sign, separator, exponent, whitespace or leading zero',
    );
  }

  if (BigInt(value) > MAX_RAW_AMOUNT) {
    throw new NonCanonicalAmountError(field, 'value exceeds the uint256 range');
  }

  return value;
}

/**
 * Provider and fiat-ramp amounts are a different kind of money: a decimal
 * quantity reported by an external counterparty and always carried alongside a
 * currency code. They are fixed-point, not uint256, so they get their own
 * canonical form rather than being forced through the scaled-integer rule.
 */
export const CANONICAL_FIAT_AMOUNT_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/;
export const MAX_FIAT_AMOUNT_LENGTH = 40;

export function assertCanonicalFiatAmount(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new NonCanonicalAmountError(field, `expected a string, received ${typeof value}`);
  }

  if (value.length === 0) {
    throw new NonCanonicalAmountError(field, 'value is empty');
  }

  if (value.length > MAX_FIAT_AMOUNT_LENGTH) {
    throw new NonCanonicalAmountError(
      field,
      `value is longer than ${MAX_FIAT_AMOUNT_LENGTH} characters`,
    );
  }

  if (!CANONICAL_FIAT_AMOUNT_PATTERN.test(value)) {
    throw new NonCanonicalAmountError(
      field,
      'value must be an unsigned decimal with at most 8 fractional digits and no sign, separator, exponent, whitespace or leading zero',
    );
  }

  return value;
}

export function isCanonicalRawAmount(value: unknown): value is string {
  try {
    assertCanonicalRawAmount(value, 'amount');
    return true;
  } catch {
    return false;
  }
}

/** Parses only after the canonical check, so BigInt never sees tolerated input. */
export function parseRawAmount(value: unknown, field: string): bigint {
  return BigInt(assertCanonicalRawAmount(value, field));
}

/** Formats a bigint back into the canonical spelling, rejecting negatives. */
export function formatRawAmount(value: bigint, field: string): string {
  if (value < 0n) {
    throw new NonCanonicalAmountError(field, 'value is negative');
  }

  if (value > MAX_RAW_AMOUNT) {
    throw new NonCanonicalAmountError(field, 'value exceeds the uint256 range');
  }

  return value.toString();
}

export function sumRawAmounts(values: readonly string[], field: string): string {
  return formatRawAmount(
    values.reduce((total, value) => total + parseRawAmount(value, field), 0n),
    field,
  );
}

/**
 * A sweep allocation may be partial, but it can never exceed the ledger entry it
 * draws from: that would let a batch claim more than the escrow ever released.
 */
export function assertAllocationWithinLedgerAmount(input: {
  entryAmountRaw: string;
  ledgerAmountRaw: string;
  ledgerEntryId: number;
}): void {
  const allocated = parseRawAmount(input.entryAmountRaw, 'entryAmountRaw');
  const available = parseRawAmount(input.ledgerAmountRaw, 'ledgerAmountRaw');

  if (allocated === 0n) {
    throw new Error(
      `Sweep allocation for ledger entry ${input.ledgerEntryId} must be greater than zero`,
    );
  }

  if (allocated > available) {
    throw new Error(
      `Sweep allocation ${input.entryAmountRaw} exceeds the eligible ledger amount ${input.ledgerAmountRaw} for entry ${input.ledgerEntryId}`,
    );
  }
}

/**
 * The batch total is the accounting claim; the allocated entries are the
 * evidence. They must agree exactly before the batch can be acted on.
 */
export function assertAllocationTotalMatchesExpected(input: {
  expectedTotalRaw: string;
  allocatedEntryAmountsRaw: readonly string[];
}): void {
  const expected = parseRawAmount(input.expectedTotalRaw, 'expectedTotalRaw');
  const allocated = parseRawAmount(
    sumRawAmounts(input.allocatedEntryAmountsRaw, 'entryAmountRaw'),
    'allocatedTotalRaw',
  );

  if (expected !== allocated) {
    throw new Error(
      `Sweep batch expected total ${input.expectedTotalRaw} does not equal the allocated total ${allocated.toString()}`,
    );
  }
}
