/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GaslessExecutorCapacityPolicy } from './gaslessExecutorCapacityPolicy';
import type { SettlementExecutionEventRecord, SettlementHandoffRecord } from './settlementStore';

export const USER_ACTIONS = [
  'open_dispute',
  'cancel_locked_timeout',
  'refund_in_transit_timeout',
  'finalize_after_dispute_window',
  'finalize_after_inspection_acceptance',
] as const;
export const OPERATOR_ACTIONS = ['finalize_after_dispute_window'] as const;

export type GaslessUserAction = (typeof USER_ACTIONS)[number];
export type GaslessOperatorAction = (typeof OPERATOR_ACTIONS)[number];

export interface GaslessBuyerAuthorization {
  nonce: string;
  deadline: string;
  signature: string;
}

export interface GaslessUsdcAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  v: number;
  r: string;
  s: string;
}

export interface GaslessCreateTradeExecutionInput {
  action: 'create_trade';
  handoffId: string;
  chainId: number;
  contractAddress: string;
  expiresAt: string;
  payloadHash: string;
  buyerAddress: string;
  supplierAddress: string;
  totalAmount: string;
  logisticsAmount: string;
  platformFeesAmount: string;
  supplierFirstTranche: string;
  supplierSecondTranche: string;
  ricardianHash: string;
  buyerAuthorization: GaslessBuyerAuthorization;
  usdcAuthorization: GaslessUsdcAuthorization;
  requestId: string;
  sourceApiKeyId?: string | null;
}

export interface GaslessUserActionAuthorization {
  nonce: string;
  deadline: string;
  signature: string;
}

export interface GaslessUserActionExecutionInput {
  action: GaslessUserAction;
  handoffId: string;
  chainId: number;
  contractAddress: string;
  expiresAt: string;
  payloadHash: string;
  userAddress: string;
  tradeId: string;
  userAuthorization: GaslessUserActionAuthorization;
  requestId: string;
  sourceApiKeyId?: string | null;
}

export interface GaslessOperatorActionExecutionInput {
  action: GaslessOperatorAction;
  handoffId: string;
  chainId: number;
  contractAddress: string;
  expiresAt: string;
  payloadHash: string;
  tradeId: string;
  requestId: string;
  sourceApiKeyId?: string | null;
}

export interface GaslessWalletUsdcTransferExecutionInput {
  action: 'wallet_usdc_transfer';
  platformTransferId: string;
  chainId: number;
  tokenAddress: string;
  authorizationDomainName: string;
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  v: number;
  r: string;
  s: string;
  requestId: string;
  sourceApiKeyId?: string | null;
}

export type GaslessCreateTradePayload = Omit<
  GaslessCreateTradeExecutionInput,
  'payloadHash' | 'requestId' | 'sourceApiKeyId'
>;
export type GaslessUserActionPayload = Omit<
  GaslessUserActionExecutionInput,
  'payloadHash' | 'requestId' | 'sourceApiKeyId'
>;
export type GaslessOperatorActionPayload = Omit<
  GaslessOperatorActionExecutionInput,
  'payloadHash' | 'requestId' | 'sourceApiKeyId'
>;

export interface GaslessCreateTradeExecutionResult {
  handoff: SettlementHandoffRecord;
  acceptedEvent: SettlementExecutionEventRecord;
  queuedEvent: SettlementExecutionEventRecord;
  simulationEvent: SettlementExecutionEventRecord;
  submittedEvent: SettlementExecutionEventRecord;
  confirmedEvent?: SettlementExecutionEventRecord;
  txHash: string;
}

export interface GaslessExecutionReceipt {
  txHash: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPriceWei: string;
  nativeCostWei: string;
  executorAddress: string;
  executorBalanceWei: string;
}

export interface GaslessExecutionSubmission {
  txHash: string;
  receipt?: GaslessExecutionReceipt;
}

export interface GaslessRelayerReadinessSnapshot {
  enabled: true;
  paused: boolean;
  state: 'ready' | 'paused' | 'degraded' | 'blocked';
  generatedAt: string;
  signerCustodyMode: 'raw_private_key' | 'kms' | 'mpc';
  activeExecutionPath: {
    chainId: number;
    escrowAddress: string;
    rpcFallbackCount: number;
  };
  controls: {
    gasLimitCap: string;
    maxFeePerGasWei: string;
    maxNativeCostWei: string;
    minExecutorBalanceWei: string;
    lowBalanceAlertWei: string;
    stuckQueueThresholdMs: number;
    receiptTimeoutMs: number;
    repeatedFailureAlertThreshold: number;
  };
  capacityPolicy: GaslessExecutorCapacityPolicy;
  executorBalanceWei: string | null;
  queue: {
    pending: number;
    active: number;
    lastQueueWaitMs: number | null;
    lastSubmissionAt: string | null;
  };
  alerts: Array<{
    code: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    detail: string;
  }>;
  recentFailureCount: number;
}

export interface GaslessSettlementExecutor {
  simulateCreateTrade(
    input: GaslessCreateTradeExecutionInput,
  ): Promise<{ gasEstimate?: bigint | string | number | null }>;
  executeCreateTrade(input: GaslessCreateTradeExecutionInput): Promise<GaslessExecutionSubmission>;
  simulateUserAction(
    input: GaslessUserActionExecutionInput,
  ): Promise<{ gasEstimate?: bigint | string | number | null }>;
  executeUserAction(input: GaslessUserActionExecutionInput): Promise<GaslessExecutionSubmission>;
  simulateOperatorAction(
    input: GaslessOperatorActionExecutionInput,
  ): Promise<{ gasEstimate?: bigint | string | number | null }>;
  executeOperatorAction(
    input: GaslessOperatorActionExecutionInput,
  ): Promise<GaslessExecutionSubmission>;
  simulateWalletUsdcTransfer(
    input: GaslessWalletUsdcTransferExecutionInput,
  ): Promise<{ gasEstimate?: bigint | string | number | null }>;
  executeWalletUsdcTransfer(
    input: GaslessWalletUsdcTransferExecutionInput,
  ): Promise<GaslessExecutionSubmission>;
}
