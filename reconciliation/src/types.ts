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
  | 'ONCHAIN_INVALID_ADDRESS'
  | 'INDEXER_TRADE_MISSING'
  | 'INDEXER_SURPLUS_RECORDS';

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

/**
 * The exact chain point every read in a run is pinned to. Reading the trade
 * counter and the trades it bounds at different heights would report a trade
 * created mid-run as a chain record the indexer never projected.
 */
export interface CoverageBoundary {
  blockNumber: number;
  blockHash: string;
  tag: 'finalized' | 'safe';
  chainTradeCounter: bigint;
}

/**
 * Complete-range accounting for one run. `nextCursor` is what the following
 * run resumes from, and `uncoveredTail` is how many chain trades remain beyond
 * this run's budget — the exposure a fixed cap used to hide.
 */
export interface CoverageWindow {
  fromTradeId: bigint;
  toTradeId: bigint;
  nextCursor: bigint;
  uncoveredTail: bigint;
  complete: boolean;
}

export interface CoverageSlaVerdict {
  breached: boolean;
  uncoveredTail: bigint;
  oldestUncoveredAgeMs: number | null;
  reason: string | null;
}

export interface RunStats {
  runKey: string;
  mode: ReconcileMode;
  totalTrades: number;
  driftCount: number;
  severityCounts: Record<DriftSeverity, number>;
  status: ReconcileRunStatus;
  skippedReason?: string;
  /** Absent only when the run was skipped before a boundary was resolved. */
  coverage?: {
    boundary: CoverageBoundary;
    window: CoverageWindow;
    fromBlock: number;
    indexerTradeCount: number | null;
    sla: CoverageSlaVerdict;
    cursorAdvanced: boolean;
  };
}

export interface ReconcileCursorRow {
  scope: string;
  last_trade_id: string;
  boundary_block_number: number;
  boundary_block_hash: string;
  updated_at: Date;
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
  coverage_from_trade_id: string | null;
  coverage_to_trade_id: string | null;
  coverage_from_block: number | null;
  coverage_to_block: number | null;
  chain_trade_counter: string | null;
  next_cursor: string | null;
  uncovered_tail: string | null;
  coverage_complete: boolean | null;
}

export interface CompareInput {
  indexedTrade: IndexedTradeRecord;
  onchainTrade: Trade | null;
  onchainReadError?: string;
}
