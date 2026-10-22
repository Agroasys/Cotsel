import type { NotificationEvent } from '@agroasys/notifications';
import { serviceNotifications } from './notifications';
import type {
  AbandonedRunRecord,
  TradeContainedAlertPayload,
  TradePauseUnconfirmedAlertPayload,
} from '../types';

/**
 * Alerting for the run-lease and scoped-containment controls.
 *
 * Kept apart from the coverage alerts because these reach a different owner:
 * an abandoned run is a platform-liveness page, and a contained trade is a
 * request for an admin scoped-pause decision.
 *
 * Alerts dispatched from the run outbox record into the notification outbox
 * and throw when they cannot, so the run outbox row stays pending.
 */
export class RunAlerts {
  private async raise(event: NotificationEvent): Promise<void> {
    await serviceNotifications.notifier.enqueue(event);
  }

  /**
   * A run's lease expired while it was RUNNING.
   *
   * Deduplicated per run key rather than globally: one crashed worker holding
   * several keys is several distinct pieces of stuck work, and collapsing them
   * would hide all but the first.
   *
   * Raised by the sweep, which has no outbox row of its own to leave pending,
   * so it uses `notify`: durable when the outbox is writable, and a direct
   * best-effort send when it is not.
   */
  async runAbandoned(record: AbandonedRunRecord): Promise<void> {
    await serviceNotifications.notifier.notify({
      source: 'reconciliation',
      type: 'RECONCILIATION_RUN_ABANDONED',
      severity: 'critical',
      dedupKey: `reconciliation:run-abandoned:${record.runKey}`,
      message:
        'A reconciliation run stopped heartbeating and was marked abandoned; its window is unreconciled until a successor claims it.',
      correlation: { runKey: record.runKey },
      metadata: {
        mode: record.mode,
        abandonedOwner: record.owner,
        leaseEpoch: record.epoch,
        startedAt: record.startedAt.toISOString(),
        leaseExpiresAt: record.leaseExpiresAt?.toISOString() ?? null,
        lastHeartbeatAt: record.lastHeartbeatAt?.toISOString() ?? null,
        takeoverCount: record.takeoverCount,
      },
    });
  }

  /**
   * A qualified discrepancy contained a trade and needs a scoped pause.
   *
   * The containment itself already blocks the trade — the oracle refuses every
   * progression for it from the moment the row commits. This alert asks for the
   * on-chain half: the escrow's own `pauseTrade` is an admin action and
   * reconciliation holds no admin key, so it names the one trade it must be
   * applied to and nothing wider.
   */
  async tradeContained(payload: TradeContainedAlertPayload): Promise<void> {
    await this.raise({
      source: 'reconciliation',
      type: 'RECONCILIATION_TRADE_CONTAINED',
      severity: 'critical',
      dedupKey: `reconciliation:contained:${payload.incidentReference}`,
      message:
        'A qualified reconciliation discrepancy contained a trade; apply the scoped pause to this trade only and do not let it progress.',
      correlation: {
        tradeId: payload.tradeId,
        runKey: payload.runKey,
      },
      metadata: {
        incidentReference: payload.incidentReference,
        qualifyingCodes: payload.qualifyingCodes.join(','),
        state: payload.state,
        openedRunKey: payload.openedRunKey,
        openedAt: payload.openedAt,
        observationCount: payload.observationCount,
      },
    });
  }

  /**
   * A contained trade is still not paused on chain.
   *
   * Off-chain the containment is already binding, but the escrow is the only
   * place a buyer-, relayer- or gasless-initiated transition is stopped, so a
   * containment that never becomes an on-chain pause leaves a path open that
   * this service does not sit in front of. Deliberately re-raised on every run
   * that finds the pause missing, and keyed per incident rather than per run, so
   * the outbox's durable cooldown collapses the repeats while the condition lasts and
   * it fires again if it is still unpaused later.
   */
  async tradePauseUnconfirmed(payload: TradePauseUnconfirmedAlertPayload): Promise<void> {
    await this.raise({
      source: 'reconciliation',
      type: 'RECONCILIATION_TRADE_PAUSE_UNCONFIRMED',
      severity: 'critical',
      dedupKey: `reconciliation:pause-unconfirmed:${payload.incidentReference}`,
      message: payload.readError
        ? 'A contained trade could not be confirmed paused on chain: the escrow read failed. Apply or verify the scoped pause manually.'
        : 'A contained trade is still not paused on chain. Apply the scoped pause to this trade now; until it lands, only reconciliation-aware callers are blocked.',
      correlation: {
        tradeId: payload.tradeId,
        runKey: payload.runKey,
      },
      metadata: {
        incidentReference: payload.incidentReference,
        observedAtBlock: payload.observedAtBlock,
        readError: payload.readError,
      },
    });
  }
}
