import {
  isTreasuryConfirmationStage,
  resolveSettlementConfirmationStage,
  SettlementConfirmationState,
} from '@agroasys/sdk';
import { PayoutState, TreasuryEntryEligibility } from '../types';
import type { LedgerEntryForExport } from '../database/queries/ledger';
import {
  ReconciliationGateService,
  type ReconciliationRunAnchor,
  type TradeReconciliationGate,
} from './reconciliationGate';
import {
  ChainCanonicalityVerifier,
  type ChainCanonicalityState,
  type ChainCanonicalityVerdict,
} from './chainCanonicality';
import {
  TreasuryIngestionFreshnessService,
  type IngestionFreshnessAssessment,
} from './ingestionFreshness';
import { canTransition } from './payout';
import { createSettlementProvider } from './settlementProvider';
import {
  getLatestBankPayoutConfirmation,
  markLedgerEntryCanonical,
  recordLedgerEntryOrphaned,
} from '../database/queries';
import { recordIngestionFreshness } from '../metrics/counters';
import { Logger } from '../utils/logger';
import {
  readSettlementHeads,
  createEligibilitySnapshotContext,
  sameReconciliationGate,
  verifySnapshotEvidence,
  type SettlementHeadProvider,
  type SnapshotEligibilityContext,
} from './exportEligibilityContext';

const EXPORTABLE_STATES: ReadonlySet<PayoutState> = new Set([
  'READY_FOR_EXTERNAL_HANDOFF',
  'AWAITING_EXTERNAL_CONFIRMATION',
  'EXTERNAL_EXECUTION_CONFIRMED',
]);

const REVOCATION_ACTOR = 'system:chain-canonicality';

interface ReconciliationGateReader {
  assessTrades(tradeIds: string[]): Promise<Map<string, TradeReconciliationGate>>;
  snapshotRunAnchor?(): Promise<ReconciliationRunAnchor>;
}

interface IngestionFreshnessReader {
  assess(options?: { stableBlockNumber?: number | null }): Promise<IngestionFreshnessAssessment>;
}

interface BankConfirmationReader {
  getLatestConfirmation(
    ledgerEntryId: number,
  ): Promise<{ bank_state: 'PENDING' | 'CONFIRMED' | 'REJECTED' } | null>;
}

interface CanonicalityWriter {
  markCanonical: typeof markLedgerEntryCanonical;
  recordOrphaned: typeof recordLedgerEntryOrphaned;
}

interface CanonicalityOutcome {
  state: ChainCanonicalityState;
  depth: number | null;
  stableBlockNumber: number | null;
  blockedReason: string | null;
}

function buildBlockedReasons(input: {
  latestState: PayoutState | null;
  confirmationState: SettlementConfirmationState | null;
  reconciliationStatus: TreasuryEntryEligibility['reconciliationStatus'];
  confirmationFailureReason: string | null;
  reconciliationBlockedReasons: string[];
  bankConfirmationState: 'PENDING' | 'CONFIRMED' | 'REJECTED' | null;
  canonicalityBlockedReason: string | null;
  ingestionBlockedReasons: string[];
  reconciliationCoverageBlockedReason: string | null;
}): string[] {
  const reasons: string[] = [];

  // WP-4 B-09 / FAIL-10. This is a property of the whole assessment, not of the
  // entry: stale ingestion does not make any one entry wrong, it makes the
  // absence of a *later* entry meaningless. Every entry therefore carries the
  // reason, so a blocked export names the outage rather than looking like a set
  // of individually unlucky rows.
  reasons.push(...input.ingestionBlockedReasons);

  if (input.confirmationFailureReason) {
    reasons.push(input.confirmationFailureReason);
  } else if (
    !input.confirmationState ||
    !isTreasuryConfirmationStage(input.confirmationState.stage)
  ) {
    reasons.push(
      `Entry has not reached Base finalized stage${input.confirmationState ? ` (current stage: ${input.confirmationState.stage})` : ''}`,
    );
  }

  // Depth alone never clears an entry, so the canonicality reason is kept
  // separate from the confirmation stage above it. Reaching the finalized head
  // says the entry is old enough; only this says it is still on the chain.
  if (input.canonicalityBlockedReason) {
    reasons.push(input.canonicalityBlockedReason);
  }

  if (input.reconciliationStatus !== 'CLEAR') {
    reasons.push(...input.reconciliationBlockedReasons);
  }

  // WP-4 H-25. Kept separate from the status above: a run can be accepted,
  // fresh and drift-free and still be evidence about a range that stops below
  // this entry. "The run was clean" and "the run reached here" are different
  // claims, and only the second one clears this entry.
  if (input.reconciliationCoverageBlockedReason) {
    reasons.push(input.reconciliationCoverageBlockedReason);
  }

  if (
    input.latestState === 'EXTERNAL_EXECUTION_CONFIRMED' &&
    input.bankConfirmationState !== 'CONFIRMED'
  ) {
    reasons.push('Confirmed external execution evidence is required before completion export.');
  }

  return Array.from(new Set(reasons));
}

/**
 * WP-4 H-25. The run's watermark is compared against the entry's own block, not
 * against the head: what matters is whether the reconciliation actually reached
 * the evidence being paid out on.
 */
function resolveCoverageBlockedReason(
  entryBlockNumber: number,
  gate: TradeReconciliationGate,
): string | null {
  if (gate.coverageToBlock === null) {
    return 'Reconciliation run has no chain coverage watermark, so it cannot be bound to this entry.';
  }

  if (entryBlockNumber > gate.coverageToBlock) {
    return `Entry block ${entryBlockNumber} is beyond reconciliation run ${gate.runKey ?? 'unknown'} coverage watermark ${gate.coverageToBlock}.`;
  }

  return null;
}

function isExportableState(state: PayoutState | null): boolean {
  return state !== null && EXPORTABLE_STATES.has(state);
}

export class TreasuryEligibilityService {
  private readonly provider: SettlementHeadProvider | null;
  private readonly reconciliationGate: ReconciliationGateReader;
  private readonly bankConfirmationReader: BankConfirmationReader;
  private readonly canonicalityVerifier: ChainCanonicalityVerifier;
  private readonly canonicalityWriter: CanonicalityWriter;
  private readonly ingestionFreshness: IngestionFreshnessReader;

  constructor(deps?: {
    provider?: SettlementHeadProvider | null;
    reconciliationGate?: ReconciliationGateReader;
    bankConfirmationReader?: BankConfirmationReader;
    canonicalityVerifier?: ChainCanonicalityVerifier;
    canonicalityWriter?: CanonicalityWriter;
    ingestionFreshness?: IngestionFreshnessReader;
  }) {
    this.provider = deps?.provider !== undefined ? deps.provider : createSettlementProvider();
    this.reconciliationGate = deps?.reconciliationGate ?? new ReconciliationGateService();
    this.bankConfirmationReader = deps?.bankConfirmationReader ?? {
      getLatestConfirmation: getLatestBankPayoutConfirmation,
    };
    this.canonicalityVerifier =
      deps?.canonicalityVerifier ??
      new ChainCanonicalityVerifier({
        provider: createSettlementProvider(),
      });
    this.canonicalityWriter = deps?.canonicalityWriter ?? {
      markCanonical: markLedgerEntryCanonical,
      recordOrphaned: recordLedgerEntryOrphaned,
    };
    this.ingestionFreshness = deps?.ingestionFreshness ?? new TreasuryIngestionFreshnessService();
  }

  async createSnapshotContext(): Promise<SnapshotEligibilityContext> {
    return createEligibilitySnapshotContext(this.provider, this.ingestionFreshness);
  }

  async verifySnapshotContext(context: SnapshotEligibilityContext): Promise<void> {
    await verifySnapshotEvidence({
      context,
      provider: this.provider,
      ingestion: this.ingestionFreshness,
      reconciliation: this.reconciliationGate,
    });
  }

  async establishEmptySnapshotContext(context: SnapshotEligibilityContext): Promise<void> {
    if (!this.reconciliationGate.snapshotRunAnchor)
      throw new Error('Reconciliation evidence is unavailable or incomplete');
    const anchor = await this.reconciliationGate.snapshotRunAnchor();
    context.reconciliationRunKey = anchor.runKey;
    context.emptyRunAnchor = anchor;
  }

  /**
   * WP-4 B-08. Re-derives the entry's chain identity before it can be exported
   * or handed off, and records the verdict.
   *
   * An entry already marked ORPHANED short-circuits: the revocation stands
   * until an approved correction, and re-asking the chain could otherwise
   * quietly restore an entry whose evidence is under review.
   */
  private async assessCanonicality(
    entry: LedgerEntryForExport,
    stableBlockNumber: number | null,
  ): Promise<CanonicalityOutcome> {
    if (entry.canonicality_state === 'ORPHANED') {
      return {
        state: 'ORPHANED',
        depth: entry.canonicality_depth,
        stableBlockNumber: entry.canonicality_stable_block_number,
        blockedReason: `Entry was orphaned by a chain reorganization at depth ${entry.canonicality_depth ?? 'unknown'} and cannot become eligible again without an approved correction.`,
      };
    }

    if (stableBlockNumber === null) {
      return {
        state: entry.canonicality_state,
        depth: entry.canonicality_depth,
        stableBlockNumber: entry.canonicality_stable_block_number,
        blockedReason:
          'Chain canonicality could not be re-verified because no finalized head is available.',
      };
    }

    const verdict = await this.canonicalityVerifier.verify(
      {
        txHash: entry.tx_hash,
        blockNumber: entry.block_number,
        blockHash: entry.block_hash,
        logIndex: entry.log_index,
        logAddress: entry.log_address,
        logIdentityHash: entry.log_identity_hash,
      },
      stableBlockNumber,
    );

    return this.applyVerdict(entry, verdict, stableBlockNumber);
  }

  private async applyVerdict(
    entry: LedgerEntryForExport,
    verdict: ChainCanonicalityVerdict,
    stableBlockNumber: number,
  ): Promise<CanonicalityOutcome> {
    if (verdict.state === 'CANONICAL') {
      // The verdict was reached against a read of this entry; another
      // assessment may have orphaned it since. The write reports the state the
      // row actually ended in, and anything other than CANONICAL means the
      // promotion did not happen and the entry stays blocked.
      const promotion = await this.canonicalityWriter.markCanonical({
        ledgerEntryId: entry.id,
        blockHash: verdict.blockHash,
        logIndex: entry.log_index as number,
        logAddress: entry.log_address as string,
        logIdentityHash: entry.log_identity_hash as string,
        stableBlockNumber,
      });

      if (promotion.state !== 'CANONICAL') {
        Logger.warn('Canonical promotion did not take effect; failing closed', {
          ledgerEntryId: entry.id,
          tradeId: entry.trade_id,
          observedState: promotion.state,
        });

        return {
          state: promotion.state,
          depth: entry.canonicality_depth,
          stableBlockNumber,
          blockedReason:
            promotion.state === 'ORPHANED'
              ? 'Entry was orphaned by a concurrent chain re-verification and cannot become eligible again without an approved correction.'
              : 'Chain canonicality could not be recorded, so the entry is not cleared for payout.',
        };
      }

      return {
        state: 'CANONICAL',
        depth: null,
        stableBlockNumber,
        blockedReason: null,
      };
    }

    if (verdict.state === 'UNVERIFIED') {
      return {
        state: 'UNVERIFIED',
        depth: entry.canonicality_depth,
        stableBlockNumber,
        blockedReason: `Chain canonicality is unproven: ${verdict.detail}`,
      };
    }

    const revocation = await this.canonicalityWriter.recordOrphaned({
      ledgerEntryId: entry.id,
      entryKey: entry.entry_key,
      tradeId: entry.trade_id,
      txHash: entry.tx_hash,
      blockNumber: entry.block_number,
      expectedBlockHash: verdict.expectedBlockHash,
      observedBlockHash: verdict.observedBlockHash,
      observedBlockNumber: verdict.observedBlockNumber,
      observedLogIndex: verdict.observedLogIndex,
      reorgDepth: verdict.depth,
      stableBlockNumber: verdict.stableBlockNumber,
      mismatchReason: verdict.reason,
      detail: verdict.detail,
      cancelFromState: canTransition(entry.latest_state, 'CANCELLED') ? entry.latest_state : null,
      actor: REVOCATION_ACTOR,
    });

    Logger.error('Treasury ledger entry orphaned by chain reorganization', {
      ledgerEntryId: entry.id,
      tradeId: entry.trade_id,
      entryKey: entry.entry_key,
      mismatchReason: verdict.reason,
      expectedBlockHash: verdict.expectedBlockHash,
      observedBlockHash: verdict.observedBlockHash,
      reorgDepth: verdict.depth,
      stableBlockNumber: verdict.stableBlockNumber,
      evidenceId: revocation.evidenceId,
      payoutCancelled: revocation.payoutCancelled,
    });

    return {
      state: 'ORPHANED',
      depth: verdict.depth,
      stableBlockNumber: verdict.stableBlockNumber,
      blockedReason: `Entry was orphaned by a chain reorganization (${verdict.reason}) at depth ${verdict.depth}: ${verdict.detail}`,
    };
  }

  async assessEntries(
    entries: LedgerEntryForExport[],
    context?: SnapshotEligibilityContext,
  ): Promise<Map<number, TreasuryEntryEligibility>> {
    const gates = new Map<number, TreasuryEntryEligibility>();
    if (entries.length === 0) {
      return gates;
    }

    this.canonicalityVerifier.resetCache();
    const { heads, failureReason } = context
      ? { heads: context.heads, failureReason: null }
      : await readSettlementHeads(this.provider);
    const stableBlockNumber = heads?.finalizedBlockNumber ?? null;

    // The finalized head is already in hand here, so the block-lag half of the
    // freshness check costs nothing extra. Readiness cannot do this -- it must
    // not depend on the settlement RPC -- which is why the assessment takes the
    // head as an option rather than reading it itself.
    const ingestion =
      context?.ingestion ?? (await this.ingestionFreshness.assess({ stableBlockNumber }));
    recordIngestionFreshness({
      status: ingestion.status,
      ageSeconds: ingestion.ageSeconds,
      maxAgeSeconds: ingestion.maxAgeSeconds,
      lagBlocks: ingestion.lagBlocks,
      maxLagBlocks: ingestion.maxLagBlocks,
      consecutiveFailureCount: ingestion.consecutiveFailureCount,
    });

    if (ingestion.blockedReasons.length > 0) {
      Logger.error('Treasury eligibility blocked by stale chain-evidence ingestion', {
        status: ingestion.status,
        ageSeconds: ingestion.ageSeconds,
        lagBlocks: ingestion.lagBlocks,
        entryCount: entries.length,
        blockedReasons: ingestion.blockedReasons,
      });
    }

    const reconciliationByTradeId = await this.reconciliationGate.assessTrades(
      entries.map((entry) => entry.trade_id),
    );

    if (context) {
      context.reconciliationByTradeId.clear();
      for (const entry of entries) {
        const gate = reconciliationByTradeId.get(entry.trade_id);
        if (
          !gate?.runKey ||
          gate.freshness !== 'FRESH' ||
          gate.coverageComplete !== true ||
          gate.coverageToBlock === null ||
          entry.block_number > gate.coverageToBlock ||
          gate.staleRunningRunCount > 0 ||
          gate.status === 'UNKNOWN'
        ) {
          throw new Error('Reconciliation evidence is unavailable or incomplete');
        }
        if (context.reconciliationRunKey && context.reconciliationRunKey !== gate.runKey) {
          throw new Error('Reconciliation run changed during export construction');
        }
        const previous = context.reconciliationByTradeId.get(entry.trade_id);
        if (previous && !sameReconciliationGate(previous, gate))
          throw new Error('Reconciliation evidence changed during export construction');
        context.reconciliationByTradeId.set(entry.trade_id, gate);
        context.reconciliationRunKey = gate.runKey;
      }
    }

    for (const entry of entries) {
      const confirmationState = heads
        ? resolveSettlementConfirmationStage(entry.block_number, heads)
        : null;
      const canonicality = await this.assessCanonicality(entry, stableBlockNumber);
      const latestBankConfirmation =
        entry.latest_state === 'EXTERNAL_EXECUTION_CONFIRMED'
          ? await this.bankConfirmationReader.getLatestConfirmation(entry.id)
          : null;
      const reconciliationGate = reconciliationByTradeId.get(entry.trade_id) ?? {
        tradeId: entry.trade_id,
        status: 'UNKNOWN',
        runKey: null,
        driftCount: 0,
        freshness: 'MISSING' as const,
        completedAt: null,
        staleRunningRunCount: 0,
        coverageFromBlock: null,
        coverageToBlock: null,
        coverageComplete: null,
        blockedReasons: ['Reconciliation status could not be determined'],
      };
      const reconciliationCoverageBlockedReason = resolveCoverageBlockedReason(
        entry.block_number,
        reconciliationGate,
      );
      const blockedReasons = buildBlockedReasons({
        latestState: entry.latest_state,
        confirmationState,
        confirmationFailureReason: failureReason,
        reconciliationStatus: reconciliationGate.status,
        reconciliationBlockedReasons: reconciliationGate.blockedReasons,
        bankConfirmationState: latestBankConfirmation?.bank_state ?? null,
        canonicalityBlockedReason: canonicality.blockedReason,
        ingestionBlockedReasons: ingestion.blockedReasons,
        reconciliationCoverageBlockedReason,
      });
      const eligibleForPayout = blockedReasons.length === 0;
      const eligibleForExport = eligibleForPayout && isExportableState(entry.latest_state);

      gates.set(entry.id, {
        entryId: entry.id,
        tradeId: entry.trade_id,
        payoutState: entry.latest_state,
        confirmationStage: confirmationState?.stage ?? null,
        latestBlockNumber: confirmationState?.latestBlockNumber ?? null,
        safeBlockNumber: confirmationState?.safeBlockNumber ?? null,
        finalizedBlockNumber: confirmationState?.finalizedBlockNumber ?? null,
        reconciliationStatus: reconciliationGate.status,
        reconciliationRunKey: reconciliationGate.runKey,
        reconciliationFreshness: reconciliationGate.freshness,
        reconciliationCompletedAt: reconciliationGate.completedAt,
        staleRunningRunCount: reconciliationGate.staleRunningRunCount,
        reconciliationCoverageToBlock: reconciliationGate.coverageToBlock,
        reconciliationCoverageComplete: reconciliationGate.coverageComplete,
        canonicalityState: canonicality.state,
        canonicalityDepth: canonicality.depth,
        canonicalityStableBlockNumber: canonicality.stableBlockNumber,
        eligibleForPayout,
        eligibleForExport,
        blockedReasons,
      });
    }

    return gates;
  }
}
