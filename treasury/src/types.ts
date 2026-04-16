import type { SettlementConfirmationStage } from '@agroasys/sdk';

export type TreasuryComponent = 'LOGISTICS' | 'PLATFORM_FEE';

export type PayoutState =
  | 'PENDING_REVIEW'
  | 'READY_FOR_PARTNER_SUBMISSION'
  | 'AWAITING_PARTNER_UPDATE'
  | 'PARTNER_REPORTED_COMPLETED'
  | 'CANCELLED';

export type FiatDepositState = 'PENDING' | 'FUNDED' | 'PARTIAL' | 'REVERSED' | 'FAILED';

export type FiatDepositFailureClass =
  | 'MISSING_TRADE_MAPPING'
  | 'DUPLICATE_PROVIDER_EVENT'
  | 'PARTIAL_FUNDING'
  | 'REVERSED_FUNDING'
  | 'STALE_PENDING_DEPOSIT'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH';

export type BankPayoutState = 'PENDING' | 'CONFIRMED' | 'REJECTED';
export type ReconciliationGateStatus = 'CLEAR' | 'BLOCKED' | 'UNKNOWN';
export type TreasuryPartnerCode = 'bridge';
export type TreasuryPartnerHandoffStatus =
  | 'SUBMITTED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETURNED';

export interface LedgerEntry {
  id: number;
  entry_key: string;
  trade_id: string;
  tx_hash: string;
  block_number: number;
  event_name: string;
  component_type: TreasuryComponent;
  amount_raw: string;
  source_timestamp: Date;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface LedgerEntryWithState extends LedgerEntry {
  latest_state: PayoutState;
  latest_state_at: Date;
}

export interface PayoutLifecycleEvent {
  id: number;
  ledger_entry_id: number;
  state: PayoutState;
  note: string | null;
  actor: string | null;
  created_at: Date;
}

export interface IndexerTradeEvent {
  id: string;
  tradeId: string;
  eventName: string;
  txHash: string | null;
  blockNumber: number;
  timestamp: Date;
  releasedLogisticsAmount?: string | null;
  paidPlatformFees?: string | null;
}

export interface FiatDepositReference {
  id: number;
  ramp_reference: string;
  trade_id: string;
  ledger_entry_id: number | null;
  deposit_state: FiatDepositState;
  source_amount: string;
  currency: string;
  expected_amount: string;
  expected_currency: string;
  observed_at: Date;
  provider_event_id: string;
  provider_account_ref: string;
  failure_class: FiatDepositFailureClass | null;
  failure_code: string | null;
  reversal_reference: string | null;
  latest_event_payload_hash: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface FiatDepositEvent {
  id: number;
  fiat_deposit_reference_id: number;
  ramp_reference: string;
  trade_id: string;
  ledger_entry_id: number | null;
  deposit_state: FiatDepositState;
  source_amount: string;
  currency: string;
  expected_amount: string;
  expected_currency: string;
  observed_at: Date;
  provider_event_id: string;
  provider_account_ref: string;
  failure_class: FiatDepositFailureClass | null;
  failure_code: string | null;
  reversal_reference: string | null;
  payload_hash: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface FiatDepositUpsertInput {
  rampReference: string;
  tradeId: string;
  ledgerEntryId?: number | null;
  depositState: FiatDepositState;
  sourceAmount: string;
  currency: string;
  expectedAmount: string;
  expectedCurrency: string;
  observedAt: Date;
  providerEventId: string;
  providerAccountRef: string;
  failureCode?: string | null;
  reversalReference?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BankPayoutConfirmation {
  id: number;
  ledger_entry_id: number;
  payout_reference: string | null;
  bank_reference: string;
  bank_state: BankPayoutState;
  confirmed_at: Date;
  source: string;
  actor: string;
  failure_code: string | null;
  evidence_reference: string | null;
  payload_hash: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface BankPayoutConfirmationUpsertInput {
  ledgerEntryId: number;
  payoutReference?: string | null;
  bankReference: string;
  bankState: BankPayoutState;
  confirmedAt: Date;
  source: string;
  actor: string;
  failureCode?: string | null;
  evidenceReference?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TreasuryPartnerHandoff {
  id: number;
  ledger_entry_id: number;
  partner_code: TreasuryPartnerCode;
  handoff_reference: string;
  partner_status: TreasuryPartnerHandoffStatus;
  payout_reference: string | null;
  transfer_reference: string | null;
  drain_reference: string | null;
  destination_external_account_id: string | null;
  liquidation_address_id: string | null;
  source_amount: string | null;
  source_currency: string | null;
  destination_amount: string | null;
  destination_currency: string | null;
  actor: string;
  note: string | null;
  failure_code: string | null;
  latest_event_payload_hash: string;
  metadata: Record<string, unknown>;
  initiated_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface TreasuryPartnerHandoffInput {
  ledgerEntryId: number;
  partnerCode: TreasuryPartnerCode;
  handoffReference: string;
  partnerStatus: TreasuryPartnerHandoffStatus;
  payoutReference?: string | null;
  transferReference?: string | null;
  drainReference?: string | null;
  destinationExternalAccountId?: string | null;
  liquidationAddressId?: string | null;
  sourceAmount?: string | null;
  sourceCurrency?: string | null;
  destinationAmount?: string | null;
  destinationCurrency?: string | null;
  actor: string;
  note?: string | null;
  failureCode?: string | null;
  initiatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface TreasuryPartnerHandoffEvent {
  id: number;
  partner_handoff_id: number;
  ledger_entry_id: number;
  partner_code: TreasuryPartnerCode;
  provider_event_id: string;
  event_type: string;
  partner_status: TreasuryPartnerHandoffStatus;
  payout_reference: string | null;
  transfer_reference: string | null;
  drain_reference: string | null;
  destination_external_account_id: string | null;
  liquidation_address_id: string | null;
  bank_reference: string | null;
  bank_state: BankPayoutState | null;
  evidence_reference: string | null;
  failure_code: string | null;
  payload_hash: string;
  metadata: Record<string, unknown>;
  observed_at: Date;
  created_at: Date;
}

export interface TreasuryPartnerHandoffEvidenceInput {
  ledgerEntryId: number;
  partnerCode: TreasuryPartnerCode;
  providerEventId: string;
  eventType: string;
  partnerStatus: TreasuryPartnerHandoffStatus;
  payoutReference?: string | null;
  transferReference?: string | null;
  drainReference?: string | null;
  destinationExternalAccountId?: string | null;
  liquidationAddressId?: string | null;
  bankReference?: string | null;
  bankState?: BankPayoutState | null;
  evidenceReference?: string | null;
  failureCode?: string | null;
  observedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface TreasuryEntryEligibility {
  entryId: number;
  tradeId: string;
  payoutState: PayoutState | null;
  confirmationStage: SettlementConfirmationStage | null;
  latestBlockNumber: number | null;
  safeBlockNumber: number | null;
  finalizedBlockNumber: number | null;
  reconciliationStatus: ReconciliationGateStatus;
  reconciliationRunKey: string | null;
  eligibleForPayout: boolean;
  eligibleForExport: boolean;
  blockedReasons: string[];
}
