import { Logger } from '../utils/logger';
import {
  markRunAlertDispatched,
  readPendingRunAlerts,
  recordRunAlertFailure,
} from '../database/alertOutbox';
import { getErrorMessage } from './runHelpers';
import type { CoverageAlerts } from './coverageAlerts';
import type { RunAlerts } from './runAlerts';
import type {
  CoverageBacklogAlertPayload,
  CriticalDriftAlertPayload,
  PendingRunAlertRow,
  TradeContainedAlertPayload,
  TradePauseUnconfirmedAlertPayload,
} from '../types';

/**
 * How many committed alerts one pass will deliver.
 *
 * A run that opens a large number of incidents should not spend the whole
 * daemon interval on webhook round trips; whatever is left stays pending and
 * the next pass takes it.
 */
const DISPATCH_BATCH = 200;

/**
 * Deliver the alerts a committed run left in the outbox.
 *
 * Every alert here describes state that is already durable, which is the point:
 * the run has passed its lease fence and its findings, containments and cursor
 * move have landed together. A failure to deliver leaves the row pending rather
 * than consuming it, so the alert arrives late instead of never — and dispatch
 * never fails the run, because a webhook outage is not a reconciliation error.
 */
export async function dispatchPendingAlerts(input: {
  coverageAlerts: CoverageAlerts;
  runAlerts: RunAlerts;
  limit?: number;
}): Promise<number> {
  let delivered = 0;

  try {
    for (const row of await readPendingRunAlerts(input.limit ?? DISPATCH_BATCH)) {
      try {
        await deliver(row, input);
        await markRunAlertDispatched(row.id);
        delivered += 1;
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        await recordRunAlertFailure(row.id, message);
        Logger.error('Could not deliver a committed reconciliation alert; it stays pending', {
          alertId: row.id,
          runKey: row.run_key,
          kind: row.kind,
          attempts: row.dispatch_attempts + 1,
          error: message,
        });
      }
    }
  } catch (error: unknown) {
    Logger.error('Could not drain the reconciliation alert outbox', {
      error: getErrorMessage(error),
    });
  }

  return delivered;
}

/**
 * The outbox is written only by `enqueueRunAlert` in this service, so each
 * payload is the shape its kind declares.
 */
async function deliver(
  row: PendingRunAlertRow,
  alerts: { coverageAlerts: CoverageAlerts; runAlerts: RunAlerts },
): Promise<void> {
  switch (row.kind) {
    case 'CRITICAL_DRIFT': {
      const payload = row.payload as unknown as CriticalDriftAlertPayload;
      await alerts.coverageAlerts.criticalDrift(payload.runKey, payload.finding);
      return;
    }

    case 'COVERAGE_BACKLOG': {
      const payload = row.payload as unknown as CoverageBacklogAlertPayload;
      await alerts.coverageAlerts.coverageBacklog(payload);
      return;
    }

    case 'TRADE_CONTAINED': {
      const payload = row.payload as unknown as TradeContainedAlertPayload;
      await alerts.runAlerts.tradeContained(payload);
      return;
    }

    case 'TRADE_PAUSE_UNCONFIRMED': {
      const payload = row.payload as unknown as TradePauseUnconfirmedAlertPayload;
      await alerts.runAlerts.tradePauseUnconfirmed(payload);
      return;
    }

    default:
      // A kind this build does not know is a row from a newer deployment. Leave
      // it pending for the deployment that understands it rather than marking
      // it delivered.
      throw new Error(`Unknown reconciliation alert kind: ${String(row.kind)}`);
  }
}
