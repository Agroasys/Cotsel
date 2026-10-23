import type { OracleTriggerFinality } from '../core/trigger-finality';

export interface OracleResponse {
  success: boolean;
  idempotencyKey: string;
  actionKey?: string;
  status: string;
  txHash?: string;
  blockNumber?: number;
  idempotent: boolean;
  message: string;
  /** Shared WP-2 finality position; `null` when the trigger owns no transaction. */
  finality?: OracleTriggerFinality | null;
  timestamp: string;
}

export interface ErrorResponse {
  success: false;
  error: string;
  message: string;
  timestamp: string;
}

export interface ReleaseStage1Request {
  tradeId: string;
  requestId: string;
}

export interface ConfirmArrivalRequest {
  tradeId: string;
  requestId: string;
}

export interface ConfirmInspectionAvailableRequest {
  tradeId: string;
  requestId: string;
}

export interface FinalizeAfterInspectionAcceptanceRequest {
  tradeId: string;
  requestId: string;
}

export interface FinalizeTradeRequest {
  tradeId: string;
  requestId: string;
}

export interface ApprovalRequest {
  idempotencyKey: string;
  actor: string;
}

export interface RejectRequest {
  idempotencyKey: string;
  actor: string;
  reason?: string;
}
