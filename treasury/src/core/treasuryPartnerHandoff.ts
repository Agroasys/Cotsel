import crypto from 'node:crypto';
import type { BankPayoutState, TreasuryPartnerCode, TreasuryPartnerHandoffStatus } from '../types';

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
