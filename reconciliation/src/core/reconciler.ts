import { config } from '../config';
import { OnchainClient } from '../blockchain/client';
import { EscrowGovernanceReader } from '../blockchain/escrowGovernance';
import { IndexerClient } from '../indexer/client';
import { Logger } from '../utils/logger';
import { classifyDrifts } from './classifier';
import { CoverageAlerts } from './coverageAlerts';
import { failRun, finalizeRun, readCoverageCursor } from '../database/queries';
import { LeaseLostError, claimRun } from '../database/leases';
import { RunLease, createLeaseOwner } from './runLease';
import { RunAlerts } from './runAlerts';
import { dispatchPendingAlerts } from './alertDispatch';
import { publishRunOutcome, resolveContainmentDecisions, sweepAbandonedRuns } from './runControls';
import {
  generateRunKey,
  getErrorMessage,
  mapWithConcurrency,
  sleep,
  logReconciliationCompleted,
} from './runHelpers';
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
import { prepareEnumeration, enumerateIndexer, verifyCycleBoundary } from './enumeration';
import {
  publishEnumerationPage,
  priorCycleHasHoldingFindings,
  aggregateCycleEvidence,
} from '../database/enumerationCycles';

export class ReconciliationService {
  private readonly onchainClient = new OnchainClient();
  private readonly escrowGovernance = new EscrowGovernanceReader();
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

      // Both sources must describe the indexer's observed height. Missing
      // checkpoints are incomplete evidence; never substitute a finality head.
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

      const discovery = await prepareEnumeration(this.indexerClient, boundary, cursor.lastTradeId);
      const window = planCoverageWindow({
        cursor: discovery.chainCursor,
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
      let coverageHold = 0;
      // Findings are buffered rather than written as they are found: the run
      // cannot know its comparisons were valid until it has re-read the
      // indexer's height at the end, and an unstable snapshot must publish no
      // drift at all.
      const pendingFindings: DriftFinding[] = [];
      const pendingScope: string[] = [];
      // Trades whose chain read *and* indexer record both came back, so this run
      // is in a position to say something about them either way. Being in scope
      // is not the same thing: a trade is in scope precisely because it was
      // looked at, including when the look failed.
      const comparedTradeIds: string[] = [];
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
          if (!pair.readError && pair.onchain) {
            comparedTradeIds.push(pair.indexed.tradeId);
          }

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

      const enumeration = await enumerateIndexer(this.indexerClient, discovery.cycle);
      if (enumeration.truncated) {
        // Discovery resumes from its persisted physical key after publication.
        // Financial coverage remains incomplete until the cycle is exhausted.
        Logger.error('Indexer id enumeration reached its bound before completing', {
          runKey,
          limit: config.indexerEnumerationLimit,
          walked: enumeration.tradeIds.length,
        });
      }
      const enumerationInput = { indexerTradeIds: enumeration.tradeIds, boundary };
      for (const finding of [
        ...detectIndexerOnlyTradeIds(enumerationInput),
        ...enumeration.duplicates,
      ]) {
        if (finding.mismatchCode !== 'INDEXER_DUPLICATE_TRADE') stats.totalTrades += 1;
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

      await verifyCycleBoundary(this.onchainClient, boundary);
      const now = new Date();
      const tailFirstSeenAt = window.uncoveredTail === 0n ? null : (cursor.tailFirstSeenAt ?? now);
      const sla = evaluateCoverageSla({
        uncoveredTail: window.uncoveredTail,
        tailFirstSeenAt: cursor.tailFirstSeenAt,
        now,
        maxAgeMs: config.coverageMaxAgeMs,
      });

      // Financial gaps hold the chain cursor while independent discovery can
      // continue. A completed cycle starts the next validation epoch at zero.
      const hold = evaluateCursorHold({
        holdingFindingCount: coverageHold,
        enumerationTruncated: enumeration.truncated,
      });
      const cursorHeld = hold.held;
      const nextCursor = planNextCursor({
        window,
        cursorHeld,
        previousCursor: discovery.chainCursor,
      });
      const sweepReset = !cursorHeld && window.complete;

      const cumulativeWalked = Number(discovery.cycle.walked) + enumeration.tradeIds.length;
      const coherent =
        discovery.coherent && indexerTradeCount === Number(discovery.cycle.expected_count);
      const cycleFinished =
        enumeration.page.exhausted && ((window.complete && !cursorHeld) || !coherent);
      const priorHold = await priorCycleHasHoldingFindings(discovery.cycle.id);
      const coverageComplete =
        coherent &&
        !priorHold &&
        cumulativeWalked === indexerTradeCount &&
        isCoverageComplete({
          windowComplete: window.complete && !cursorHeld,
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
        indexerEnumerationWalked: cumulativeWalked,
        enumerationCycleId: discovery.cycle.id,
        indexerSourceCoherent: coherent,
        indexerEnumerationExpected: Number(discovery.cycle.expected_count),
        complete: coverageComplete,
        indexerProcessedBlock: boundary.indexerProcessedBlock,
      };

      // Containment decisions are settled from this run's own comparisons
      // before the transaction opens; nothing is written until the fence has
      // passed.
      const containment = await resolveContainmentDecisions({
        reader: this.escrowGovernance,
        findings: pendingFindings,
        comparedTradeIds,
        boundaryBlock: boundary.blockNumber,
      });

      await finalizeRun({
        stats,
        lease,
        publish: async (client) => {
          await publishEnumerationPage(
            {
              cycle: discovery.cycle,
              page: enumeration.page,
              coherent,
              finished: cycleFinished,
              nextChainCursor: cursorHeld ? discovery.chainCursor : window.nextCursor,
              runId: row.id,
            },
            client,
          );
          await publishRunOutcome(
            {
              runId: row.id,
              runKey,
              stats,
              boundary,
              window,
              sla,
              scopedTradeIds: pendingScope,
              findings: pendingFindings,
              ...containment,
            },
            client,
          );
          if (cycleFinished) {
            await aggregateCycleEvidence(
              { cycleId: discovery.cycle.id, runId: row.id, runKey, stats },
              client,
            );
            if (stats.coverage && coherent) {
              stats.coverage.window = { ...window, fromTradeId: 0n };
              stats.coverage.fromBlock = 0;
            }
          }
        },
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

      logReconciliationCompleted(stats);

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
      // Dispatched from committed state, on every exit path: an outbox row left
      // behind by a worker that died between COMMIT and delivery is still owed
      // to an operator, and this is the next run that can pay it.
      await dispatchPendingAlerts({
        coverageAlerts: this.alerts,
        runAlerts: this.runAlerts,
      });
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
