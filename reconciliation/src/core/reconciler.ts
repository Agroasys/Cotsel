import { config } from '../config';
import { OnchainClient } from '../blockchain/client';
import { IndexerClient } from '../indexer/client';
import { Logger } from '../utils/logger';
import { classifyDrifts } from './classifier';
import { CoverageAlerts } from './coverageAlerts';
import {
  createRun,
  failRun,
  finalizeRun,
  readCoverageCursor,
  upsertDrift,
  upsertRunTradeScope,
} from '../database/queries';
import {
  batchTradeIds,
  checkIndexerSurplus,
  compareCoverage,
  detectIndexerOnlyTradeIds,
  evaluateCoverageSla,
  evaluateCursorHold,
  evaluateIndexerSnapshot,
  holdsCursor,
  isCoverageComplete,
  planCoverageWindow,
  planNextCursor,
  tradeIdsInWindow,
  type ChainTradeRecord,
} from './coverage';
import { DriftFinding, DriftSeverity, ReconcileMode, RunStats } from '../types';

const DEFAULT_SEVERITY_COUNTS: Record<DriftSeverity, number> = {
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generateRunKey(mode: ReconcileMode): string {
  if (mode === 'DAEMON') {
    const bucket = Math.floor(Date.now() / config.daemonIntervalMs);
    return `daemon-${bucket}`;
  }
  return `once-${new Date().toISOString()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded-concurrency map, so a wide window cannot stampede the RPC endpoint. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

function skippedStats(
  runKey: string,
  mode: ReconcileMode,
  row: {
    total_trades: number;
    drift_count: number;
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
  },
  skippedReason: string,
): RunStats {
  return {
    runKey,
    mode,
    status: 'SKIPPED',
    totalTrades: row.total_trades,
    driftCount: row.drift_count,
    severityCounts: {
      CRITICAL: row.critical_count,
      HIGH: row.high_count,
      MEDIUM: row.medium_count,
      LOW: row.low_count,
    },
    skippedReason,
  };
}

export class ReconciliationService {
  private readonly onchainClient = new OnchainClient();
  private readonly indexerClient = new IndexerClient(config.indexerGraphqlUrl);
  private readonly alerts = new CoverageAlerts();
  private async recordFinding(
    runId: number,
    runKey: string,
    finding: DriftFinding,
    stats: RunStats,
  ): Promise<void> {
    await upsertDrift(runId, runKey, finding);
    await this.alerts.criticalDrift(runKey, finding);

    stats.driftCount += 1;
    stats.severityCounts[finding.severity] += 1;

    Logger.warn('Reconciliation drift detected', {
      runKey,
      tradeId: finding.tradeId,
      mismatchCode: finding.mismatchCode,
      severity: finding.severity,
    });
  }

  async reconcileOnce(mode: ReconcileMode, runKeyOverride?: string): Promise<RunStats> {
    const runKey = runKeyOverride || generateRunKey(mode);
    const run = await createRun(runKey, mode);

    if (!run.created && run.row.status === 'COMPLETED') {
      Logger.warn('Skipping already completed reconciliation run key', { runKey, mode });
      return skippedStats(runKey, mode, run.row, 'run_key already completed');
    }

    if (!run.created && run.row.status === 'RUNNING') {
      Logger.warn('Skipping run key currently marked RUNNING', { runKey, mode });
      return skippedStats(runKey, mode, run.row, 'run_key currently running');
    }

    const stats: RunStats = {
      runKey,
      mode,
      status: 'COMPLETED',
      totalTrades: 0,
      driftCount: 0,
      severityCounts: { ...DEFAULT_SEVERITY_COUNTS },
    };

    try {
      // The indexer only reports its current projection, so the one height both
      // sides can describe is the block it has processed. Anchor every chain
      // read in this run to that block.
      const indexerProcessedBlock = await this.indexerClient.fetchProcessedBlock();
      const boundary = await this.onchainClient.resolveBoundary(indexerProcessedBlock);

      if (boundary.indexerAhead) {
        Logger.warn(
          'Indexer processed past the chain finality boundary; anchoring to the indexer block',
          {
            runKey,
            indexerProcessedBlock: boundary.indexerProcessedBlock,
            finalityBlockNumber: boundary.finalityBlockNumber,
            boundaryTag: boundary.tag,
          },
        );
      }

      const cursor = await readCoverageCursor();
      const window = planCoverageWindow({
        cursor: cursor.lastTradeId,
        chainTradeCounter: boundary.chainTradeCounter,
        budget: config.maxTradesPerRun,
      });

      Logger.info('Reconciliation coverage window planned', {
        runKey,
        fromTradeId: window.fromTradeId.toString(),
        toTradeId: window.toTradeId.toString(),
        chainTradeCounter: boundary.chainTradeCounter.toString(),
        boundaryBlock: boundary.blockNumber,
        boundaryTag: boundary.tag,
        uncoveredTail: window.uncoveredTail.toString(),
      });

      const windowIds = tradeIdsInWindow(window);
      // Any finding that proves a range has not been reconciled — a projection
      // gap, an indexer surplus, or an inconclusive chain read — holds the
      // cursor. A transient RPC failure must never retire the ids it could not
      // check.
      let coverageHold = 0;
      // Findings are buffered rather than written as they are found: the run
      // cannot know its comparisons were valid until it has re-read the
      // indexer's height at the end, and an unstable snapshot must publish no
      // drift at all.
      const pendingFindings: DriftFinding[] = [];
      const pendingScope: string[] = [];
      const record = (finding: DriftFinding): void => {
        pendingFindings.push(finding);
        if (holdsCursor(finding.mismatchCode)) {
          coverageHold += 1;
        }
      };

      for (const idBatch of batchTradeIds(windowIds, config.batchSize)) {
        const chainTrades = await mapWithConcurrency<string, ChainTradeRecord>(
          idBatch,
          config.chainReadConcurrency,
          async (tradeId) => {
            try {
              return {
                tradeId,
                trade: await this.onchainClient.getTrade(tradeId, boundary.blockNumber),
              };
            } catch (error: unknown) {
              return { tradeId, trade: null, readError: getErrorMessage(error) };
            }
          },
        );

        const indexedTrades = await this.indexerClient.fetchTradesByIds(idBatch);
        const comparison = compareCoverage({
          window,
          boundary,
          chainTrades,
          indexedTrades,
        });

        for (const finding of comparison.missingFromIndexer) {
          stats.totalTrades += 1;
          pendingScope.push(finding.tradeId);
          record(finding);
        }

        for (const pair of comparison.paired) {
          stats.totalTrades += 1;
          pendingScope.push(pair.indexed.tradeId);

          for (const finding of classifyDrifts({
            indexedTrade: pair.indexed,
            onchainTrade: pair.onchain,
            onchainReadError: pair.readError,
          })) {
            record(finding);
          }
        }

        for (const indexerOnly of comparison.indexerOnly) {
          // Defensive: `fetchTradesByIds` filters on `tradeId_in`, so in the real
          // path it cannot return an id outside the window. The authoritative
          // indexer-only detection is the independent enumeration below.
          stats.totalTrades += 1;
          pendingScope.push(indexerOnly.tradeId);
          record({
            tradeId: indexerOnly.tradeId,
            severity: 'CRITICAL',
            mismatchCode: 'ONCHAIN_TRADE_MISSING',
            comparedField: 'tradePresence',
            onchainValue: null,
            indexedValue: indexerOnly.tradeId,
            details: {
              reason: 'indexer returned a trade outside the chain-derived id window',
              boundaryBlock: boundary.blockNumber,
            },
          });
        }
      }

      // Independent indexer-side enumeration. Walking the indexer's own id set
      // catches a record the chain never allocated directly, rather than by a
      // count that a separately-missing id could cancel it out of.
      const enumeration = await this.indexerClient.fetchTradeIds(
        config.indexerEnumerationLimit,
        config.indexerEnumerationPageSize,
      );
      if (enumeration.truncated) {
        // Ids beyond the bound were never checked, so the indexer-only
        // direction is unproven over the rest of the range. The hold below
        // keeps them in scope for the next run instead of retiring them behind
        // a run that claims a complete sweep.
        Logger.error('Indexer id enumeration reached its bound before completing', {
          runKey,
          limit: config.indexerEnumerationLimit,
          walked: enumeration.tradeIds.length,
        });
      }
      for (const finding of detectIndexerOnlyTradeIds({
        indexerTradeIds: enumeration.tradeIds,
        boundary,
      })) {
        stats.totalTrades += 1;
        pendingScope.push(finding.tradeId);
        record(finding);
      }

      let indexerTradeCount: number | null = null;
      try {
        indexerTradeCount = await this.indexerClient.fetchTradeCount();
      } catch (error: unknown) {
        Logger.warn('Could not read indexer trade count for the surplus check', {
          runKey,
          error: getErrorMessage(error),
        });
      }

      const surplus = checkIndexerSurplus({ indexerTradeCount, boundary });
      if (surplus) {
        record(surplus);
      }

      // Every indexer read for this run is now done. If the projection moved
      // while they ran, the batches, the enumeration and the count each saw a
      // different height than the chain reads were anchored to, and any
      // difference between them is an artefact. Publish nothing and hold.
      const snapshot = evaluateIndexerSnapshot({
        anchorBlock: boundary.indexerProcessedBlock,
        endBlock: await this.indexerClient.fetchProcessedBlock(),
      });

      if (!snapshot.stable) {
        Logger.error('Discarding an unstable reconciliation snapshot without publishing drift', {
          runKey,
          mode,
          reason: snapshot.reason,
          discardedFindings: pendingFindings.length,
          anchorBlock: boundary.indexerProcessedBlock,
        });

        const inconclusive: RunStats = {
          ...stats,
          status: 'SKIPPED',
          totalTrades: 0,
          driftCount: 0,
          severityCounts: { ...DEFAULT_SEVERITY_COUNTS },
          skippedReason: snapshot.reason ?? 'indexer snapshot unstable',
        };
        await finalizeRun({
          stats: inconclusive,
          cursor: { advance: false, tailFirstSeenAt: cursor.tailFirstSeenAt },
        });
        return inconclusive;
      }

      for (const tradeId of pendingScope) {
        await upsertRunTradeScope(run.row.id, runKey, tradeId);
      }
      for (const finding of pendingFindings) {
        await this.recordFinding(run.row.id, runKey, finding, stats);
      }

      const now = new Date();
      const tailFirstSeenAt = window.uncoveredTail === 0n ? null : (cursor.tailFirstSeenAt ?? now);
      const sla = evaluateCoverageSla({
        uncoveredTail: window.uncoveredTail,
        tailFirstSeenAt: cursor.tailFirstSeenAt,
        now,
        maxAgeMs: config.coverageMaxAgeMs,
      });

      // A gap parks the cursor: advancing past an unreconciled range would
      // retire the evidence and let the next run report clean. Otherwise a run
      // that reached the counter resets to a fresh epoch (cursor 0) so existing
      // trades are swept again — without the reset, once the cursor reaches the
      // counter every later run plans an empty window forever.
      const hold = evaluateCursorHold({
        holdingFindingCount: coverageHold,
        enumerationTruncated: enumeration.truncated,
      });
      const cursorHeld = hold.held;
      const nextCursor = planNextCursor({
        window,
        cursorHeld,
        previousCursor: cursor.lastTradeId,
      });
      const sweepReset = !cursorHeld && window.complete;

      const coverageComplete = isCoverageComplete({
        windowComplete: window.complete,
        enumerationTruncated: enumeration.truncated,
      });

      stats.coverage = {
        boundary,
        window,
        fromBlock: cursor.boundaryBlockNumber,
        indexerTradeCount,
        sla,
        cursorAdvanced: !cursorHeld,
        nextCursor,
        sweepReset,
        indexerEnumerationTruncated: enumeration.truncated,
        indexerEnumerationWalked: enumeration.tradeIds.length,
        complete: coverageComplete,
        indexerProcessedBlock: boundary.indexerProcessedBlock,
      };

      // The run's complete-range accounting and the cursor move commit together:
      // the cursor must never advance past a window whose run was not recorded.
      await finalizeRun({
        stats,
        cursor: cursorHeld
          ? { advance: false, tailFirstSeenAt }
          : {
              advance: true,
              lastTradeId: nextCursor,
              boundaryBlockNumber: boundary.blockNumber,
              boundaryBlockHash: boundary.blockHash,
              tailFirstSeenAt,
            },
      });

      if (cursorHeld) {
        Logger.error('Holding the reconciliation cursor on an unresolved coverage gap', {
          runKey,
          reasons: hold.reasons,
          heldAtTradeId: cursor.lastTradeId.toString(),
        });
      }

      if (sla.breached && sla.reason) {
        await this.alerts.coverageBacklog(runKey, sla.reason, window.uncoveredTail, boundary);
      }

      Logger.info('Reconciliation run completed', {
        runKey,
        mode,
        totalTrades: stats.totalTrades,
        driftCount: stats.driftCount,
        critical: stats.severityCounts.CRITICAL,
        high: stats.severityCounts.HIGH,
        coveredFromTradeId: window.fromTradeId.toString(),
        coveredToTradeId: window.toTradeId.toString(),
        blockInterval: `${cursor.boundaryBlockNumber}..${boundary.blockNumber}`,
        nextCursor: nextCursor.toString(),
        uncoveredTail: window.uncoveredTail.toString(),
        coverageComplete,
        windowComplete: window.complete,
        indexerEnumerationTruncated: enumeration.truncated,
        indexerEnumerationWalked: enumeration.tradeIds.length,
        indexerProcessedBlock: boundary.indexerProcessedBlock,
        cursorAdvanced: !cursorHeld,
        sweepReset,
        slaBreached: sla.breached,
      });

      return stats;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      await failRun(runKey, message);
      Logger.error('Reconciliation run failed', { runKey, mode, error: message });
      throw error;
    }
  }

  async runDaemon(): Promise<void> {
    if (!config.enabled) {
      Logger.warn('Reconciliation daemon disabled by config', {
        configKey: 'RECONCILIATION_ENABLED',
        currentValue: config.enabled,
      });
      return;
    }

    Logger.info('Reconciliation daemon started', {
      intervalMs: config.daemonIntervalMs,
      batchSize: config.batchSize,
      maxTradesPerRun: config.maxTradesPerRun,
      coverageBoundary: config.coverageBoundary,
      coverageMaxAgeMs: config.coverageMaxAgeMs,
    });

    while (true) {
      try {
        await this.reconcileOnce('DAEMON');
      } catch (error: unknown) {
        Logger.error('Daemon run failed', { error: getErrorMessage(error) });
      }

      await sleep(config.daemonIntervalMs);
    }
  }
}
