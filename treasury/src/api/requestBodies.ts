/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Request body shapes for the treasury API. These are the untrusted wire
 * payloads: a field named here is what a caller may send, not what the handler
 * trusts. Actor fields in particular are claims checked against the
 * authenticated principal by `actorBinding`, never used as identity directly.
 */
import type {
  BankPayoutState,
  FiatDepositState,
  PartnerHandoffStatus,
  TreasuryPartnerCode,
  TreasuryPartnerHandoffStatus,
} from '../types';

export type AppendStateBody = {
  state?: string;
  note?: string;
  actor?: string;
};

export type UpsertDepositBody = {
  rampReference?: string;
  tradeId?: string;
  ledgerEntryId?: number | null;
  depositState?: FiatDepositState;
  sourceAmount?: string;
  currency?: string;
  expectedAmount?: string;
  expectedCurrency?: string;
  observedAt?: string;
  providerEventId?: string;
  providerAccountRef?: string;
  failureCode?: string | null;
  reversalReference?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpsertBankConfirmationBody = {
  payoutReference?: string | null;
  bankReference?: string;
  bankState?: BankPayoutState;
  confirmedAt?: string;
  source?: string;
  actor?: string;
  failureCode?: string | null;
  evidenceReference?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreateAccountingPeriodBody = {
  periodKey?: string;
  startsAt?: string;
  endsAt?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
};

export type UpdateAccountingPeriodStatusBody = {
  actor?: string;
  closeReason?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreateSweepBatchBody = {
  batchKey?: string;
  accountingPeriodId?: number;
  assetSymbol?: string;
  expectedTotalRaw?: string;
  payoutReceiverAddress?: string | null;
  createdBy?: string;
  metadata?: Record<string, unknown>;
};

export type AddSweepBatchEntryBody = {
  ledgerEntryId?: number;
  allocatedBy?: string;
  entryAmountRaw?: string;
};

export type UpdateSweepBatchStatusBody = {
  actor?: string;
  matchedSweepTxHash?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpsertPartnerHandoffBody = {
  actor?: string;
  partnerName?: string;
  partnerReference?: string;
  handoffStatus?: PartnerHandoffStatus;
  evidenceReference?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreateRevenueRealizationBody = {
  accountingPeriodId?: number;
  sweepBatchId?: number | null;
  partnerHandoffId?: number | null;
  actor?: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpsertTreasuryPartnerHandoffBody = {
  partnerCode?: TreasuryPartnerCode;
  handoffReference?: string;
  partnerStatus?: TreasuryPartnerHandoffStatus;
  payoutReference?: string | null;
  transferReference?: string | null;
  drainReference?: string | null;
  destinationExternalAccountId?: string | null;
  liquidationAddressId?: string | null;
  sourceAmount?: string | null;
  sourceCurrency?: string | null;
  destinationAmount?: string | null;
  destinationCurrency?: string | null;
  actor?: string;
  note?: string | null;
  failureCode?: string | null;
  initiatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type AppendTreasuryPartnerHandoffEvidenceBody = {
  partnerCode?: TreasuryPartnerCode;
  providerEventId?: string;
  eventType?: string;
  partnerStatus?: TreasuryPartnerHandoffStatus;
  payoutReference?: string | null;
  transferReference?: string | null;
  drainReference?: string | null;
  destinationExternalAccountId?: string | null;
  liquidationAddressId?: string | null;
  bankReference?: string | null;
  bankState?: BankPayoutState | null;
  evidenceReference?: string | null;
  failureCode?: string | null;
  observedAt?: string;
  metadata?: Record<string, unknown>;
};
