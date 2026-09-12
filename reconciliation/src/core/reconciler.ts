import { config } from '../config';
import { OnchainClient } from '../blockchain/client';
import { IndexerClient } from '../indexer/client';
import { Logger } from '../utils/logger';
import { classifyDrifts } from './classifier';
import { CoverageAlerts } from './coverageAlerts';
import { failRun, finalizeRun, readCoverageCursor, upsertRunTradeScope } from '../database/queries';
import { LeaseLostError, claimRun } from '../database/leases';
import { RunLease, createLeaseOwner } from './runLease';
import { RunAlerts } from './runAlerts';
import { applyContainment, publishFinding, sweepAbandonedRuns } from './runControls';
import { generateRunKey, getErrorMessage, mapWithConcurrency, sleep } from './runHelpers';
import {
  batchTradeIds,
  checkIndexerSurplus,
  compareCoverage,
  detectIndexerOnlyTradeIds,
  evaluateCoverageSla,
  evaluateCursorHold,
  evaluateIndexerAnchor,
  evaluateIndexerSnapshot,
  holdsCursor,
  isCoverageComplete,
  planCoverageWindow,
  planNextCursor,
  tradeIdsInWindow,
  type ChainTradeRecord,
} from './coverage';
import { DEFAULT_SEVERITY_COUNTS, finalizeInconclusiveRun, skippedStats } from './runOutcome';
import { DriftFinding, ReconcileMode, RunStats } from '../types';

export class ReconciliationService {
  private readonly onchainClient = new OnchainClient();
  private readonly indexerClient = new IndexerClient(config.indexerGraphqlUrl);
  private readonly alerts = new CoverageAlerts();
  private readonly runAlerts = new RunAlerts();
  async reconcileOnce(mode: ReconcileMode, runKeyOverride?: string): Promise<RunStats> {
    const runKey = runKeyOverride || generateRunKey(mode);

    await sweepAbandonedRuns(this.runAlerts);

    const claim = await claimRun({
      runKey,
      mode,
      owner: createLeaseOwner(),
      leaseTtlMs: config.leaseTtlMs,
    });

    if (!claim.claimed) {
      if (claim.refusal === 'ALREADY_COMPLETED') {
        Logger.warn('Skipping already completed reconciliation run key', { runKey, mode });
        return skippedStats(runKey, mode, claim.row, 'run_key already completed');
      }

      Logger.warn('Skipping run key held by a live lease on another worker', {
        runKey,
        mode,
        leaseOwner: claim.row.lease_owner,
        leaseExpiresAt: claim.row.lease_expires_at?.toISOString() ?? null,
      });
      return skippedStats(runKey, mode, claim.row, 'run_key lease held by another worker');
    }

    const { row, lease, takeoverFrom } = claim.run;

    if (takeoverFrom) {
      Logger.warn('Reclaimed an abandoned reconciliation run as its successor', {
        runKey,
        mode,
        previousOwner: takeoverFrom,
        leaseOwner: lease.owner,
        leaseEpoch: lease.epoch,
        takeoverCount: row.takeover_count,
      });
    }

    const runLease = new RunLease({
      identity: lease,
      leaseTtlMs: config.leaseTtlMs,
      heartbeatIntervalMs: config.leaseHeartbeatMs,
    });
    runLease.start();

    const stats: RunStats = {
      runKey,
      mode,
      status: 'COMPLETED',
      totalTrades: 0,
      driftCount: 0,
      severityCounts: { ...DEFAULT_SEVERITY_COUNTS },
    };

    try {
      const cursor = await readCoverageCursor();

      // The indexer only reports its current projection, so the one height both
      // sides can describe is the block it has processed. Anchor every chain
      // read in this run to that block. Without a checkpoint there is nothing to
      // anchor to, so the run stops here rather than resolving a boundary: a
      // substituted finality block is a real block number, and the end-of-run
      // snapshot check would accept it whenever the final height read happens to
      // land on the same height.
      const anchor = evaluateIndexerAnchor(await this.indexerClient.fetchProcessedBlock());
      if (!anchor.usable) {
        return finalizeInconclusiveRun({
          stats,
          lease,
          reason: anchor.reason,
          tailFirstSeenAt: cursor.tailFirstSeenAt,
          context: { stage: 'indexer-anchor' },
        });
      }

      const boundary = await this.onchainClient.resolveBoundary(anchor.anchorBlock);

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
        // Stop at a batch edge rather than spending the rest of the window on
        // comparisons the finalize fence is going to refuse anyway.
        runLease.assertHeld();

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
        return finalizeInconclusiveRun({
          stats,
          lease,
          reason: snapshot.reason ?? 'indexer snapshot unstable',
          tailFirstSeenAt: cursor.tailFirstSeenAt,
          context: {
            stage: 'indexer-snapshot',
            discardedFindings: pendingFindings.length,
            anchorBlock: boundary.indexerProcessedBlock,
          },
        });
      }

      for (const tradeId of pendingScope) {
        await upsertRunTradeScope(row.id, runKey, tradeId);
      }
      for (const finding of pendingFindings) {
        await publishFinding({
          alerts: this.alerts,
          runId: row.id,
          runKey,
          finding,
          stats,
        });
      }

      stats.containedTradeIds = await applyContainment({
        alerts: this.runAlerts,
        runKey,
        boundary,
        publishedFindings: pendingFindings,
        scopedTradeIds: pendingScope,
      });

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
        lease,
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
      if (error instanceof LeaseLostError) {
        // The successor owns this key and has redone, or is redoing, the same
        // window. Writing anything here — including a FAILED status — would
        // describe work that is no longer this worker's to report.
        Logger.error('Reconciliation run discarded after losing its lease', {
          runKey,
          mode,
          leaseOwner: lease.owner,
          leaseEpoch: lease.epoch,
        });

        return {
          ...stats,
          status: 'SKIPPED',
          totalTrades: 0,
          driftCount: 0,
          severityCounts: { ...DEFAULT_SEVERITY_COUNTS },
          skippedReason: 'lease lost to a successor',
        };
      }

      const message = getErrorMessage(error);
      const recorded = await failRun(lease, message);
      Logger.error('Reconciliation run failed', {
        runKey,
        mode,
        error: message,
        statusRecorded: recorded,
      });
      throw error;
    } finally {
      await runLease.release();
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
