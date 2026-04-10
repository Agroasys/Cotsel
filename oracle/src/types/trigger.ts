import type { SettlementConfirmationStage } from '@agroasys/sdk';

export enum TriggerStatus {
  PENDING = 'PENDING',
  EXECUTING = 'EXECUTING',
  SUBMITTED = 'SUBMITTED',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  EXHAUSTED_NEEDS_REDRIVE = 'EXHAUSTED_NEEDS_REDRIVE',
  TERMINAL_FAILURE = 'TERMINAL_FAILURE', // for validation/business logic errors (should never happen)
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  REJECTED = 'REJECTED',
}

export enum TriggerType {
  RELEASE_STAGE_1 = 'RELEASE_STAGE_1',
  CONFIRM_ARRIVAL = 'CONFIRM_ARRIVAL',
  FINALIZE_TRADE = 'FINALIZE_TRADE',
}

export enum ErrorType {
  VALIDATION = 'VALIDATION',
  NETWORK = 'NETWORK',
  CONTRACT = 'CONTRACT',
  TERMINAL = 'TERMINAL',
  INDEXER_LAG = 'INDEXER_LAG',
}

export interface Trigger {
  id: number;

  action_key: string;
  request_id: string;
  idempotency_key: string; // combined action_key:request_id

  trade_id: string;
  trigger_type: TriggerType;
  request_hash: string | null;

  attempt_count: number;
  status: TriggerStatus;

  tx_hash: string | null;
  block_number: bigint | null;
  confirmation_stage: SettlementConfirmationStage | null;
  confirmation_stage_at: Date | null;

  indexer_confirmed: boolean;
  indexer_confirmed_at: Date | null;
  indexer_event_id: string | null;

  last_error: string | null;
  error_type: ErrorType | null;

  on_chain_verified: boolean;
  on_chain_verified_at: Date | null;

  created_at: Date;
  submitted_at: Date | null;
  confirmed_at: Date | null;
  updated_at: Date;

  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
}

export interface CreateTriggerData {
  actionKey: string;
  requestId: string;
  idempotencyKey: string;
  tradeId: string;
  triggerType: TriggerType;
  requestHash: string | null;
  status: TriggerStatus;
}

export interface UpdateTriggerData {
  status?: TriggerStatus;
  attempt_count?: number;
  tx_hash?: string;
  block_number?: bigint;
  confirmation_stage?: SettlementConfirmationStage;
  confirmation_stage_at?: Date;
  indexer_confirmed?: boolean;
  indexer_confirmed_at?: Date;
  indexer_event_id?: string;
  last_error?: string;
  error_type?: ErrorType;
  submitted_at?: Date;
  confirmed_at?: Date;
  on_chain_verified?: boolean;
  on_chain_verified_at?: Date;

  approved_by?: string;
  approved_at?: Date;
  rejected_by?: string;
  rejected_at?: Date;
}
