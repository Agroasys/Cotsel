export interface OracleResponse {
  success: boolean;
  idempotencyKey: string;
  actionKey?: string;
  status: string;
  txHash?: string;
  blockNumber?: number;
  message: string;
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
