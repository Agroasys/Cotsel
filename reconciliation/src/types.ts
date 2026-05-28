import type { Trade } from '@agroasys/sdk';

export type ReconcileMode = 'ONCE' | 'DAEMON';

export type ReconcileRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export type DriftSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type DriftCode =
  | 'ONCHAIN_READ_ERROR'
  | 'ONCHAIN_TRADE_MISSING'
  | 'STATUS_MISMATCH'
  | 'PARTICIPANT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'FEE_COMPONENT_MISMATCH'
  | 'HASH_MISMATCH'
  | 'ARRIVAL_TIMESTAMP_MISMATCH'
  | 'INDEXED_INVALID_ADDRESS'
  | 'ONCHAIN_INVALID_ADDRESS';

export interface IndexedTradeRecord {
  tradeId: string;
  buyer: string;
  supplier: string;
  status: string;
  totalAmountLocked: bigint;
  logisticsAmount: bigint;
  platformFeesAmount: bigint;
  platformFeeNetAmount: bigint;
  settlementSupportFeeAmount: bigint;
  supplierFirstTranche: bigint;
  supplierSecondTranche: bigint;
  ricardianHash: string;
  createdAt: Date;
  arrivalTimestamp: Date | null;
}

export interface DriftFinding {
  tradeId: string;
  severity: DriftSeverity;
  mismatchCode: DriftCode;
  comparedField: string;
  onchainValue: string | null;
  indexedValue: string | null;
  details: Record<string, string | number | boolean | null>;
}

export interface RunStats {
  runKey: string;
  mode: ReconcileMode;
  totalTrades: number;
  driftCount: number;
  severityCounts: Record<DriftSeverity, number>;
  status: ReconcileRunStatus;
  skippedReason?: string;
}

export interface ReconcileRunRow {
  id: number;
  run_key: string;
  mode: ReconcileMode;
  status: ReconcileRunStatus;
  started_at: Date;
  completed_at: Date | null;
  total_trades: number;
  drift_count: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  error_message: string | null;
}

export interface CompareInput {
  indexedTrade: IndexedTradeRecord;
  onchainTrade: Trade | null;
  onchainReadError?: string;
}
