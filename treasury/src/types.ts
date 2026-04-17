import type { SettlementConfirmationStage } from '@agroasys/sdk';

export type TreasuryComponent = 'LOGISTICS' | 'PLATFORM_FEE';

export type PayoutState =
  | 'PENDING_REVIEW'
  | 'READY_FOR_EXTERNAL_HANDOFF'
  | 'AWAITING_EXTERNAL_CONFIRMATION'
  | 'EXTERNAL_EXECUTION_CONFIRMED'
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
export type AccountingPeriodStatus = 'OPEN' | 'PENDING_CLOSE' | 'CLOSED';
export type SweepBatchStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'EXECUTED'
  | 'HANDED_OFF'
  | 'CLOSED'
  | 'VOID';
export type SweepBatchAllocationStatus = 'ALLOCATED' | 'RELEASED';
export type PartnerHandoffStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'COMPLETED'
  | 'FAILED';
export type RevenueRealizationStatus = 'REALIZED' | 'REVERSED';
export type TreasuryAccountingState =
  | 'HELD'
  | 'ALLOCATED_TO_SWEEP'
  | 'SWEPT'
  | 'HANDED_OFF'
  | 'REALIZED'
  | 'EXCEPTION';

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

export interface AccountingPeriod {
  id: number;
  period_key: string;
  starts_at: Date;
  ends_at: Date;
  status: AccountingPeriodStatus;
  created_by: string;
  close_reason: string | null;
  pending_close_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SweepBatch {
  id: number;
  batch_key: string;
  accounting_period_id: number;
  asset_symbol: string;
  status: SweepBatchStatus;
  expected_total_raw: string;
  payout_receiver_address: string | null;
  approval_requested_at: Date | null;
  approval_requested_by: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  matched_sweep_tx_hash: string | null;
  matched_sweep_block_number: string | null;
  matched_swept_at: Date | null;
  executed_by: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  created_by: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SweepBatchEntry {
  id: number;
  sweep_batch_id: number;
  ledger_entry_id: number;
  allocation_status: SweepBatchAllocationStatus;
  entry_amount_raw: string;
  allocated_by: string;
  released_by: string | null;
  release_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PartnerHandoff {
  id: number;
  sweep_batch_id: number;
  partner_name: string;
  partner_reference: string;
  handoff_status: PartnerHandoffStatus;
  latest_payload_hash: string;
  evidence_reference: string | null;
  submitted_at: Date | null;
  acknowledged_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  verified_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface RevenueRealization {
  id: number;
  ledger_entry_id: number;
  accounting_period_id: number;
  sweep_batch_id: number | null;
  partner_handoff_id: number | null;
  realization_status: RevenueRealizationStatus;
  realized_at: Date;
  recognized_by: string;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface TreasuryClaimEvent {
  id: number;
  source_event_id: string;
  matched_sweep_batch_id: number | null;
  tx_hash: string;
  block_number: number;
  observed_at: Date;
  treasury_identity: string;
  payout_receiver: string;
  amount_raw: string;
  triggered_by: string | null;
  created_at: Date;
}

export interface SweepBatchWithPeriod extends SweepBatch {
  accounting_period_key: string;
  accounting_period_status: AccountingPeriodStatus;
}

export interface SweepBatchDetail {
  batch: SweepBatchWithPeriod;
  entries: LedgerEntryAccountingProjection[];
  partnerHandoff: PartnerHandoff | null;
  totals: {
    allocatedAmountRaw: string;
    entryCount: number;
  };
}

export interface PayoutLifecycleEvent {
  id: number;
  ledger_entry_id: number;
  state: PayoutState;
  note: string | null;
  actor: string | null;
  created_at: Date;
}

export interface LedgerEntryAccountingFacts {
  ledger_entry_id: number;
  trade_id: string;
  component_type: TreasuryComponent;
  amount_raw: string;
  allocated_amount_raw: string | null;
  allocated_at?: Date | null;
  earned_at: Date;
  payout_state: PayoutState | null;
  accounting_period_id: number | null;
  accounting_period_key: string | null;
  accounting_period_status: AccountingPeriodStatus | null;
  sweep_batch_id: number | null;
  sweep_batch_status: SweepBatchStatus | null;
  allocation_status: SweepBatchAllocationStatus | null;
  matched_sweep_tx_hash: string | null;
  matched_sweep_block_number: number | null;
  matched_swept_at: Date | null;
  matched_treasury_identity: string | null;
  matched_payout_receiver: string | null;
  matched_claim_amount_raw: string | null;
  partner_handoff_id: number | null;
  partner_name: string | null;
  partner_reference: string | null;
  partner_handoff_status: PartnerHandoffStatus | null;
  partner_submitted_at?: Date | null;
  partner_acknowledged_at?: Date | null;
  partner_completed_at: Date | null;
  partner_failed_at?: Date | null;
  partner_verified_at?: Date | null;
  latest_fiat_deposit_ramp_reference?: string | null;
  latest_fiat_deposit_state: FiatDepositState | null;
  latest_fiat_deposit_failure_class?: FiatDepositFailureClass | null;
  latest_fiat_deposit_observed_at?: Date | null;
  latest_bank_reference?: string | null;
  latest_bank_payout_state: BankPayoutState | null;
  latest_bank_failure_code?: string | null;
  latest_bank_confirmed_at?: Date | null;
  revenue_realization_status: RevenueRealizationStatus | null;
  realized_at: Date | null;
}

export interface LedgerEntryAccountingProjection extends LedgerEntryAccountingFacts {
  accounting_state: TreasuryAccountingState;
  accounting_state_reason: string;
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

export interface IndexerTreasuryClaimEvent {
  id: string;
  eventName: 'TreasuryClaimed';
  txHash: string;
  blockNumber: number;
  timestamp: Date;
  claimAmount: string;
  treasuryIdentity: string;
  payoutReceiver: string;
  triggeredBy: string | null;
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

export type TreasuryCloseIssueSeverity = 'BLOCKING' | 'WARNING';
export type TreasuryCloseIssueOwner = 'TREASURY' | 'FINANCE' | 'RECONCILIATION' | 'OPS';

export interface TreasuryCloseIssue {
  code: string;
  severity: TreasuryCloseIssueSeverity;
  owner: TreasuryCloseIssueOwner;
  message: string;
  trade_id: string | null;
  sweep_batch_id: number | null;
  ledger_entry_id: number | null;
  details: Record<string, unknown>;
}

export interface TreasuryPeriodRollforwardReport {
  period: AccountingPeriod;
  generated_at: string;
  opening_held_raw: string;
  new_accruals_raw: string;
  allocated_to_batches_raw: string;
  swept_onchain_raw: string;
  handed_off_raw: string;
  realized_raw: string;
  ending_held_raw: string;
  unresolved_exception_raw: string;
  blocking_issue_count: number;
  warning_issue_count: number;
  blocking_issues: TreasuryCloseIssue[];
  warning_issues: TreasuryCloseIssue[];
}

export interface TreasuryBatchTraceEntry {
  ledger_entry_id: number;
  trade_id: string;
  component_type: TreasuryComponent;
  source_amount_raw: string;
  allocated_amount_raw: string | null;
  earned_at: string;
  accounting_state: TreasuryAccountingState;
  accounting_state_reason: string;
  matched_sweep_tx_hash: string | null;
  matched_swept_at: string | null;
  partner_reference: string | null;
  partner_handoff_status: PartnerHandoffStatus | null;
  latest_bank_reference: string | null;
  latest_bank_payout_state: BankPayoutState | null;
  latest_bank_confirmed_at: string | null;
  revenue_realization_status: RevenueRealizationStatus | null;
  realized_at: string | null;
}

export interface TreasuryBatchTraceReport {
  batch: SweepBatchWithPeriod;
  claim_event: TreasuryClaimEvent | null;
  partner_handoff: PartnerHandoff | null;
  totals: {
    expected_total_raw: string;
    allocated_total_raw: string;
    entry_count: number;
  };
  entries: TreasuryBatchTraceEntry[];
  blocking_issues: TreasuryCloseIssue[];
  warning_issues: TreasuryCloseIssue[];
}

export interface TreasuryAccountingPeriodClosePacket {
  period: AccountingPeriod;
  generated_at: string;
  ready_for_close: boolean;
  rollforward: TreasuryPeriodRollforwardReport;
  reconciliation: {
    status: 'CLEAR' | 'BLOCKED' | 'STALE' | 'MISSING' | 'UNKNOWN';
    freshness: 'FRESH' | 'STALE' | 'MISSING';
    latest_completed_run_key: string | null;
    latest_completed_run_at: string | null;
    stale_running_run_count: number;
    blocked_reasons: string[];
  };
  batches: TreasuryBatchTraceReport[];
  blocking_issues: TreasuryCloseIssue[];
  warning_issues: TreasuryCloseIssue[];
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
  reconciliationFreshness: 'FRESH' | 'STALE' | 'MISSING';
  reconciliationCompletedAt: Date | null;
  staleRunningRunCount: number;
  eligibleForPayout: boolean;
  eligibleForExport: boolean;
  blockedReasons: string[];
}
