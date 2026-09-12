import { config } from '../config';
import { Logger } from '../utils/logger';
import { upsertDrift } from '../database/queries';
import { markAbandonedRuns } from '../database/leases';
import {
  listBlockingContainments,
  openContainment,
  recordCleanReconciliation,
} from '../database/containments';
import {
  buildContainmentEvidence,
  generateIncidentReference,
  qualifyDiscrepancies,
} from './containment';
import { getErrorMessage } from './runHelpers';
import type { CoverageAlerts } from './coverageAlerts';
import type { RunAlerts } from './runAlerts';
import type { CoverageBoundary, DriftFinding, RunStats } from '../types';

/**
 * Write one drift finding and route its alert, keeping the run's severity
 * tallies in step with what was actually persisted.
 */
export async function publishFinding(input: {
  alerts: CoverageAlerts;
  runId: number;
  runKey: string;
  finding: DriftFinding;
  stats: RunStats;
}): Promise<void> {
  await upsertDrift(input.runId, input.runKey, input.finding);
  await input.alerts.criticalDrift(input.runKey, input.finding);

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
 * Apply PRES-11 scoped containment to a run's published findings.
 *
 * Containment is deliberately narrow: only the trades carrying a qualifying
 * discrepancy are contained, and only those trades. Reconciliation holds no
 * admin key, so it records the incident and requests the escrow's scoped
 * `pauseTrade` control through the alert — it never pauses the platform, and it
 * never releases a trade on its own evidence.
 *
 * Returns the trade ids contained by this run.
 */
export async function applyContainment(input: {
  alerts: RunAlerts;
  runKey: string;
  boundary: CoverageBoundary;
  publishedFindings: DriftFinding[];
  scopedTradeIds: string[];
}): Promise<string[]> {
  const qualified = qualifyDiscrepancies(input.publishedFindings);
  const divergingNow = new Set(qualified.map((discrepancy) => discrepancy.tradeId));

  for (const discrepancy of qualified) {
    const { row, opened } = await openContainment({
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
    });

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

    await input.alerts.tradeContained({
      runKey: input.runKey,
      containment: row,
      qualifyingCodes: discrepancy.codes,
    });
  }

  // Only trades this run actually compared can supply clearance evidence, and
  // only those already carrying an incident are worth a write.
  const scoped = new Set(input.scopedTradeIds);
  for (const containment of await listBlockingContainments()) {
    if (divergingNow.has(containment.trade_id) || !scoped.has(containment.trade_id)) {
      continue;
    }

    const cleared = await recordCleanReconciliation({
      tradeId: containment.trade_id,
      runKey: input.runKey,
    });

    if (cleared) {
      Logger.warn('Contained trade reconciled clean; it stays blocked pending governed approval', {
        runKey: input.runKey,
        tradeId: cleared.trade_id,
        incidentReference: cleared.incident_reference,
        state: cleared.state,
      });
    }
  }

  return [...divergingNow];
}
