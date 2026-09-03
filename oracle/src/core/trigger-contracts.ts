import type { TriggerStatus, TriggerType } from '../types/trigger';

export interface TriggerRequest {
  tradeId: string;
  requestId: string;
  triggerType: TriggerType;
  requestHash?: string;
  isRedrive?: boolean;
}

export interface TriggerResponse {
  idempotencyKey: string;
  actionKey: string;
  requestId: string;
  status: TriggerStatus;
  txHash?: string;
  blockNumber?: number;
  idempotent: boolean;
  message: string;
}
