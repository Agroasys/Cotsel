import crypto from 'node:crypto';
import { BankPayoutConfirmationUpsertInput, BankPayoutState, PayoutState } from '../types';

export class BankPayoutConflictError extends Error {
  readonly code = 'BANK_PAYOUT_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'BankPayoutConflictError';
  }
}

export const BANK_PAYOUT_STATES: BankPayoutState[] = ['PENDING', 'CONFIRMED', 'REJECTED'];

export function assertBankPayoutState(value: string): asserts value is BankPayoutState {
  if (!BANK_PAYOUT_STATES.includes(value as BankPayoutState)) {
    throw new Error('Invalid bank payout state');
  }
}

function assertNonEmpty(name: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function normalizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  return metadata && Object.keys(metadata).length > 0 ? metadata : {};
}

export function normalizeBankPayoutConfirmationInput(
  input: BankPayoutConfirmationUpsertInput,
): BankPayoutConfirmationUpsertInput {
  return {
    ledgerEntryId: input.ledgerEntryId,
    payoutReference: input.payoutReference?.trim() || null,
    bankReference: assertNonEmpty('bankReference', input.bankReference),
    bankState: input.bankState,
    confirmedAt: input.confirmedAt,
    source: assertNonEmpty('source', input.source),
    actor: assertNonEmpty('actor', input.actor),
    failureCode: input.failureCode?.trim() || null,
    evidenceReference: input.evidenceReference?.trim() || null,
    metadata: normalizeMetadata(input.metadata),
  };
}

export function createBankPayoutPayloadHash(input: BankPayoutConfirmationUpsertInput): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        ledgerEntryId: input.ledgerEntryId,
        payoutReference: input.payoutReference ?? null,
        bankReference: input.bankReference,
        bankState: input.bankState,
        confirmedAt: input.confirmedAt.toISOString(),
        source: input.source,
        actor: input.actor,
        failureCode: input.failureCode ?? null,
        evidenceReference: input.evidenceReference ?? null,
        metadata: input.metadata ?? {},
      }),
    )
    .digest('hex');
}

export function assertBankPayoutTransition(
  currentPayoutState: PayoutState,
  bankState: BankPayoutState,
): void {
  if (
    currentPayoutState === 'PENDING_REVIEW' ||
    currentPayoutState === 'READY_FOR_EXTERNAL_HANDOFF'
  ) {
    throw new Error(
      `External execution evidence is not valid while payout state is ${currentPayoutState}`,
    );
  }

  if (currentPayoutState === 'CANCELLED') {
    throw new Error('External execution evidence is not valid for cancelled payout entries');
  }

  if (bankState === 'PENDING' && currentPayoutState !== 'AWAITING_EXTERNAL_CONFIRMATION') {
    throw new Error(
      'Pending external execution evidence requires state AWAITING_EXTERNAL_CONFIRMATION',
    );
  }
}
