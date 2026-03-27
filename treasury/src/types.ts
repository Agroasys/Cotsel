export type TreasuryComponent = 'LOGISTICS' | 'PLATFORM_FEE';

export type PayoutState =
  | 'PENDING_REVIEW'
  | 'READY_FOR_PAYOUT'
  | 'PROCESSING'
  | 'PAID'
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
  extrinsicHash: string | null;
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
