import crypto from 'node:crypto';
import type { BankPayoutState, TreasuryPartnerCode, TreasuryPartnerHandoffStatus } from '../types';

export class TreasuryPartnerHandoffConflictError extends Error {
  readonly code = 'TREASURY_PARTNER_HANDOFF_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'TreasuryPartnerHandoffConflictError';
  }
}

/**
 * WP-4 B-09 / FAIL-11. The batch-level equivalent, raised when contradictory
 * provider evidence freezes a sweep batch's external handoff. It is a separate
 * class from the ledger-entry one because the containment differs: freezing a
 * batch holds every entry allocated to it.
 */
export class PartnerHandoffConflictError extends Error {
  readonly code = 'PARTNER_HANDOFF_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'PartnerHandoffConflictError';
  }
}

export interface TreasuryPartnerHandoffPayloadHashInput {
  ledgerEntryId: number;
  partnerCode: TreasuryPartnerCode;
  handoffReference: string;
  partnerStatus: TreasuryPartnerHandoffStatus;
  payoutReference: string | null;
  transferReference: string | null;
  drainReference: string | null;
  destinationExternalAccountId: string | null;
  liquidationAddressId: string | null;
  sourceAmount: string | null;
  sourceCurrency: string | null;
  destinationAmount: string | null;
  destinationCurrency: string | null;
  actor: string;
  note: string | null;
  failureCode: string | null;
  initiatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface TreasuryPartnerHandoffEvidencePayloadHashInput {
  ledgerEntryId: number;
  partnerCode: TreasuryPartnerCode;
  providerEventId: string;
  eventType: string;
  partnerStatus: TreasuryPartnerHandoffStatus;
  payoutReference: string | null;
  transferReference: string | null;
  drainReference: string | null;
  destinationExternalAccountId: string | null;
  liquidationAddressId: string | null;
  bankReference: string | null;
  bankState: BankPayoutState | null;
  evidenceReference: string | null;
  failureCode: string | null;
  observedAt: Date;
  metadata: Record<string, unknown>;
}

function createPayloadHash(input: object): string {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function createTreasuryPartnerHandoffPayloadHash(
  input: TreasuryPartnerHandoffPayloadHashInput,
): string {
  return createPayloadHash(input);
}

export function createTreasuryPartnerHandoffEvidencePayloadHash(
  input: TreasuryPartnerHandoffEvidencePayloadHashInput,
): string {
  return createPayloadHash(input);
}
