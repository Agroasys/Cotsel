import type { PoolClient } from 'pg';
import { config } from '../config';
import { Logger } from '../utils/logger';
import { upsertDrift, upsertRunTradeScope } from '../database/queries';
import { markAbandonedRuns } from '../database/leases';
import { enqueueRunAlert } from '../database/alertOutbox';
import {
  listBlockingContainments,
  openContainment,
  recordCleanReconciliation,
  recordPauseObservation,
} from '../database/containments';
import {
  buildContainmentEvidence,
  cleanlyReconciledTradeIds,
  generateIncidentReference,
  qualifyDiscrepancies,
} from './containment';
import type { QualifiedDiscrepancy } from './containment';
import { getErrorMessage } from './runHelpers';
import type { EscrowGovernanceReader } from '../blockchain/escrowGovernance';
import type { RunAlerts } from './runAlerts';
import type {
  CoverageBoundary,
  CoverageSlaVerdict,
  CoverageWindow,
  DriftFinding,
  RunStats,
  TradePauseObservation,
} from '../types';

/**
 * Write one drift finding and queue its alert, keeping the run's severity
 * tallies in step with what was actually persisted.
 *
 * Both halves ride the caller's transaction. The alert is queued rather than
 * sent: until the transaction commits, this finding is a claim a displaced
 * worker might still be fenced out of making, and an operator must not be
 * paged about evidence that never lands.
 */
export async function publishFinding(
  input: {
    runId: number;
    runKey: string;
    finding: DriftFinding;
    stats: RunStats;
  },
  client: PoolClient,
): Promise<void> {
  await upsertDrift(input.runId, input.runKey, input.finding, client);

  if (input.finding.severity === 'CRITICAL') {
    await enqueueRunAlert(
      {
        runId: input.runId,
        runKey: input.runKey,
        alert: {
          kind: 'CRITICAL_DRIFT',
          payload: { runKey: input.runKey, finding: input.finding },
        },
      },
      client,
    );
  }

  input.stats.driftCount += 1;
  input.stats.severityCounts[input.finding.severity] += 1;

  Logger.warn('Reconciliation drift detected', {
    runKey: input.runKey,
    tradeId: input.finding.tradeId,
    mismatchCode: input.finding.mismatchCode,
    severity: input.finding.severity,
  });
}

/**
 * Mark and alert on every run whose lease has lapsed.
 *
 * Runs before each claim so a stuck run is recorded and paged as abandoned in
 * its own right, rather than only being noticed if something happens to want
 * its key back. A sweep that cannot run must not stop reconciliation: the lease
 * fence still protects correctness without it.
 *
 * Alerted directly rather than through the outbox: the sweep owns no run's
 * lease, its UPDATE is already committed by the time it returns, and the run it
 * is reporting on is by definition not going to publish anything.
 */
export async function sweepAbandonedRuns(alerts: RunAlerts): Promise<void> {
  try {
    for (const record of await markAbandonedRuns(config.leaseTtlMs)) {
      Logger.error('Reconciliation run abandoned: its lease expired without a heartbeat', {
        runKey: record.runKey,
        mode: record.mode,
        abandonedOwner: record.owner,
        leaseEpoch: record.epoch,
        startedAt: record.startedAt.toISOString(),
        lastHeartbeatAt: record.lastHeartbeatAt?.toISOString() ?? null,
      });
      await alerts.runAbandoned(record);
    }
  } catch (error: unknown) {
    Logger.error('Could not sweep abandoned reconciliation runs', {
      error: getErrorMessage(error),
    });
  }
}

/**
 * Read the escrow's scoped pause for the trades a containment decision depends
 * on.
 *
 * Runs before the publishing transaction opens, because these are RPC round
 * trips and the transaction holds a row lock on the run: a slow endpoint must
 * not be able to stretch the fenced window. A read that fails is carried as a
 * failure rather than swallowed — not knowing whether a trade is paused is not
 * the same as knowing it is.
 */
export async function observeTradePauses(
  reader: EscrowGovernanceReader,
  tradeIds: Iterable<string>,
  blockNumber: number,
): Promise<Map<string, TradePauseObservation>> {
  const observations = new Map<string, TradePauseObservation>();

  for (const tradeId of new Set(tradeIds)) {
    try {
      observations.set(tradeId, {
        tradeId,
        paused: await reader.isTradePaused(tradeId, blockNumber),
        blockNumber,
        readError: null,
      });
    } catch (error: unknown) {
      observations.set(tradeId, {
        tradeId,
        paused: false,
        blockNumber,
        readError: getErrorMessage(error),
      });
    }
  }

  return observations;
}

export interface ContainmentDecisions {
  qualified: QualifiedDiscrepancy[];
  cleanTradeIds: ReadonlySet<string>;
  pauseObservations: ReadonlyMap<string, TradePauseObservation>;
}

/**
 * Work out what this run's comparisons imply for containment, before anything
 * is written.
 *
 * Settled outside the fenced transaction on purpose. The decisions come from
 * comparisons the run has already finished, and the pause reads are RPC round
 * trips — a slow endpoint must not be able to stretch the window in which the
 * run holds a lock on its own row.
 */
export async function resolveContainmentDecisions(input: {
  reader: EscrowGovernanceReader;
  findings: DriftFinding[];
  comparedTradeIds: string[];
  boundaryBlock: number;
}): Promise<ContainmentDecisions> {
  const qualified = qualifyDiscrepancies(input.findings);

  // Every trade a containment decision will touch: the ones this run is
  // containing, and the ones already contained whose pause has not been seen
  // land yet.
  const inherited = await listBlockingContainments();

  return {
    qualified,
    cleanTradeIds: cleanlyReconciledTradeIds({
      comparedTradeIds: input.comparedTradeIds,
      findings: input.findings,
    }),
    pauseObservations: await observeTradePauses(
      input.reader,
      [
        ...qualified.map((discrepancy) => discrepancy.tradeId),
        ...inherited.map((containment) => containment.trade_id),
      ],
      input.boundaryBlock,
    ),
  };
}

/**
 * Apply PRES-11 scoped containment to a run's published findings.
 *
 * Containment is deliberately narrow: only the trades carrying a qualifying
 * discrepancy are contained, and only those trades. The containment row is the
 * control itself, not a note about one — the oracle refuses every progression
 * for a trade named here, from the moment this transaction commits, so the
 * trade is blocked without waiting for an operator. Reconciliation holds no
 * admin key, so the escrow's own scoped `pauseTrade` is still requested through
 * the alert, and a containment whose pause never lands is re-raised every run;
 * until it lands, callers that do not consult this table — a buyer acting
 * directly on the escrow — are outside what this control can stop.
 *
 * It never releases a trade on its own evidence.
 *
 * Every write rides the caller's fenced transaction; alerts are queued, not
 * sent. Returns the trade ids contained by this run.
 */
export async function applyContainment(
  input: {
    runId: number;
    runKey: string;
    boundary: CoverageBoundary;
    qualified: QualifiedDiscrepancy[];
    /** Trades this run compared successfully and found nothing wrong with. */
    cleanTradeIds: ReadonlySet<string>;
    pauseObservations: ReadonlyMap<string, TradePauseObservation>;
  },
  client: PoolClient,
): Promise<string[]> {
  const divergingNow = new Set(input.qualified.map((discrepancy) => discrepancy.tradeId));

  for (const discrepancy of input.qualified) {
    const { row, opened } = await openContainment(
      {
        tradeId: discrepancy.tradeId,
        incidentReference: generateIncidentReference(),
        runKey: input.runKey,
        qualifyingCodes: discrepancy.codes,
        evidence: buildContainmentEvidence({
          runKey: input.runKey,
          boundaryBlock: input.boundary.blockNumber,
          boundaryBlockHash: input.boundary.blockHash,
          discrepancy,
        }),
      },
      client,
    );

    Logger.error(
      opened
        ? 'Qualified reconciliation discrepancy contained a trade'
        : 'Qualified reconciliation discrepancy observed again on a contained trade',
      {
        runKey: input.runKey,
        tradeId: discrepancy.tradeId,
        incidentReference: row.incident_reference,
        qualifyingCodes: discrepancy.codes,
        observationCount: row.observation_count,
      },
    );

    await enqueueRunAlert(
      {
        runId: input.runId,
        runKey: input.runKey,
        alert: {
          kind: 'TRADE_CONTAINED',
          payload: {
            runKey: input.runKey,
            tradeId: row.trade_id,
            incidentReference: row.incident_reference,
            state: row.state,
            qualifyingCodes: discrepancy.codes,
            openedRunKey: row.opened_run_key,
            openedAt: row.opened_at.toISOString(),
            observationCount: row.observation_count,
          },
        },
      },
      client,
    );
  }

  // Re-read inside the transaction so the pass below sees the containments this
  // run just opened alongside the ones it inherited.
  for (const containment of await listBlockingContainments(client)) {
    // Only trades this run actually reconciled clean can supply clearance
    // evidence, and a trade diverging in this very run supplies none.
    if (!divergingNow.has(containment.trade_id) && input.cleanTradeIds.has(containment.trade_id)) {
      const cleared = await recordCleanReconciliation(
        { tradeId: containment.trade_id, runKey: input.runKey },
        client,
      );

      if (cleared) {
        Logger.warn(
          'Contained trade reconciled clean; it stays blocked pending governed approval',
          {
            runKey: input.runKey,
            tradeId: cleared.trade_id,
            incidentReference: cleared.incident_reference,
            state: cleared.state,
          },
        );
      }
    }

    const observation = input.pauseObservations.get(containment.trade_id);
    if (!observation) {
      continue;
    }

    await recordPauseObservation(observation, client);
    if (observation.paused) {
      continue;
    }

    Logger.error('Contained trade is not paused on chain', {
      runKey: input.runKey,
      tradeId: containment.trade_id,
      incidentReference: containment.incident_reference,
      boundaryBlock: observation.blockNumber,
      readError: observation.readError,
    });

    await enqueueRunAlert(
      {
        runId: input.runId,
        runKey: input.runKey,
        alert: {
          kind: 'TRADE_PAUSE_UNCONFIRMED',
          payload: {
            runKey: input.runKey,
            tradeId: containment.trade_id,
            incidentReference: containment.incident_reference,
            observedAtBlock: observation.blockNumber,
            readError: observation.readError,
          },
        },
      },
      client,
    );
  }

  return [...divergingNow];
}

/**
 * Everything one run has to say, written under the caller's lease fence.
 *
 * Kept together, and kept in one transaction, because these writes only make
 * sense as a set: the drift findings, the trades the run looked at, the
 * containments those findings open, and the alerts that describe them. Split
 * across transactions — as they were when each was written as it was produced —
 * a worker displaced after its last batch could commit some of them and be
 * fenced out of the rest, leaving an operator paged about a containment for a
 * window its successor was already redoing.
 */
export async function publishRunOutcome(
  input: {
    runId: number;
    runKey: string;
    stats: RunStats;
    boundary: CoverageBoundary;
    window: CoverageWindow;
    sla: CoverageSlaVerdict;
    scopedTradeIds: string[];
    findings: DriftFinding[];
    qualified: QualifiedDiscrepancy[];
    cleanTradeIds: ReadonlySet<string>;
    pauseObservations: ReadonlyMap<string, TradePauseObservation>;
  },
  client: PoolClient,
): Promise<void> {
  for (const tradeId of input.scopedTradeIds) {
    await upsertRunTradeScope(input.runId, input.runKey, tradeId, client);
  }

  for (const finding of input.findings) {
    await publishFinding(
      { runId: input.runId, runKey: input.runKey, finding, stats: input.stats },
      client,
    );
  }

  input.stats.containedTradeIds = await applyContainment(
    {
      runId: input.runId,
      runKey: input.runKey,
      boundary: input.boundary,
      qualified: input.qualified,
      cleanTradeIds: input.cleanTradeIds,
      pauseObservations: input.pauseObservations,
    },
    client,
  );

  if (input.sla.breached && input.sla.reason) {
    await enqueueRunAlert(
      {
        runId: input.runId,
        runKey: input.runKey,
        alert: {
          kind: 'COVERAGE_BACKLOG',
          payload: {
            runKey: input.runKey,
            reason: input.sla.reason,
            uncoveredTail: input.window.uncoveredTail.toString(),
            chainTradeCounter: input.boundary.chainTradeCounter.toString(),
            boundaryBlock: input.boundary.blockNumber,
          },
        },
      },
      client,
    );
  }
}
