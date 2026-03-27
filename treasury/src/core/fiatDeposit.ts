import crypto from 'node:crypto';
import {
  FiatDepositFailureClass,
  FiatDepositState,
  FiatDepositUpsertInput,
  LedgerEntry,
} from '../types';

export class FiatDepositConflictError extends Error {
  readonly code = 'FIAT_DEPOSIT_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'FiatDepositConflictError';
  }
}

export const FIAT_DEPOSIT_STATES: FiatDepositState[] = ['PENDING', 'FUNDED', 'PARTIAL', 'REVERSED', 'FAILED'];

export function assertFiatDepositState(value: string): asserts value is FiatDepositState {
  if (!FIAT_DEPOSIT_STATES.includes(value as FiatDepositState)) {
    throw new Error('Invalid fiat deposit state');
  }
}

function assertNonEmpty(name: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function assertPositiveIntegerString(name: string, value: string): string {
  const trimmed = assertNonEmpty(name, value);
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${name} must be a non-negative integer string`);
  }
  return trimmed;
}

function normalizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  return metadata && Object.keys(metadata).length > 0 ? metadata : {};
}

export function normalizeFiatDepositInput(input: FiatDepositUpsertInput): FiatDepositUpsertInput {
  return {
    rampReference: assertNonEmpty('rampReference', input.rampReference),
    tradeId: assertNonEmpty('tradeId', input.tradeId),
    ledgerEntryId: input.ledgerEntryId ?? null,
    depositState: input.depositState,
    sourceAmount: assertPositiveIntegerString('sourceAmount', input.sourceAmount),
    currency: assertNonEmpty('currency', input.currency).toUpperCase(),
    expectedAmount: assertPositiveIntegerString('expectedAmount', input.expectedAmount),
    expectedCurrency: assertNonEmpty('expectedCurrency', input.expectedCurrency).toUpperCase(),
    observedAt: input.observedAt,
    providerEventId: assertNonEmpty('providerEventId', input.providerEventId),
    providerAccountRef: assertNonEmpty('providerAccountRef', input.providerAccountRef),
    failureCode: input.failureCode?.trim() || null,
    reversalReference: input.reversalReference?.trim() || null,
    metadata: normalizeMetadata(input.metadata),
  };
}

export function createFiatDepositPayloadHash(input: FiatDepositUpsertInput): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        rampReference: input.rampReference,
        tradeId: input.tradeId,
        ledgerEntryId: input.ledgerEntryId ?? null,
        depositState: input.depositState,
        sourceAmount: input.sourceAmount,
        currency: input.currency,
        expectedAmount: input.expectedAmount,
        expectedCurrency: input.expectedCurrency,
        observedAt: input.observedAt.toISOString(),
        providerEventId: input.providerEventId,
        providerAccountRef: input.providerAccountRef,
        failureCode: input.failureCode ?? null,
        reversalReference: input.reversalReference ?? null,
        metadata: input.metadata ?? {},
      }),
    )
    .digest('hex');
}

export function deriveFiatDepositFailureClass(
  input: FiatDepositUpsertInput,
  matchedLedgerEntry: LedgerEntry | null,
): FiatDepositFailureClass | null {
  if (!matchedLedgerEntry) {
    return 'MISSING_TRADE_MAPPING';
  }

  if (input.currency !== input.expectedCurrency) {
    return 'CURRENCY_MISMATCH';
  }

  if (input.depositState === 'REVERSED') {
    return 'REVERSED_FUNDING';
  }

  const sourceAmount = BigInt(input.sourceAmount);
  const expectedAmount = BigInt(input.expectedAmount);

  if (sourceAmount < expectedAmount || input.depositState === 'PARTIAL') {
    return 'PARTIAL_FUNDING';
  }

  if (sourceAmount !== expectedAmount) {
    return 'AMOUNT_MISMATCH';
  }

  return null;
}
