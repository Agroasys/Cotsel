import { randomUUID } from 'node:crypto';
import type { NotificationEvent } from './index';

/**
 * The registered event envelope (docs/api/events/envelope.v1.schema.json,
 * Cotsel#949). Every notification the outbox stores also carries this
 * envelope, so relays and consumers (#957, #958) read one shape, deduplicate on
 * `eventId` and order by `orderingKey`.
 */
export const NOTIFICATION_ENVELOPE_TYPE = 'cotsel.notification';
export const NOTIFICATION_ENVELOPE_SCHEMA_VERSION = 'v1';

/**
 * The notification types registered in docs/api/events (notification-event v1).
 * scripts/check-event-registry.mjs fails CI if this list and the registry
 * differ, or if a producer emits a type that is not registered. It is not a
 * runtime gate: an alert must never be dropped because of its schema.
 */
export const REGISTERED_NOTIFICATION_TYPES = [
  'INDEXER_POISON_LOG',
  'ORACLE_CONFIRMATION_TIMEOUT',
  'ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE',
  'ORACLE_TRIGGER_TERMINAL_FAILURE',
  'RECONCILIATION_COVERAGE_BACKLOG',
  'RECONCILIATION_COVERAGE_GAP',
  'RECONCILIATION_CRITICAL_DRIFT',
  'RECONCILIATION_RUN_ABANDONED',
  'RECONCILIATION_TRADE_CONTAINED',
  'RECONCILIATION_TRADE_PAUSE_UNCONFIRMED',
] as const;

export interface EventEnvelope<TPayload> {
  eventId: string;
  type: string;
  schemaVersion: string;
  producer: string;
  settlementId: string | null;
  orderingKey: string;
  occurredAt: string;
  payload: TPayload;
}

export interface EnvelopeOptions {
  eventId?: string;
  occurredAt?: Date;
}

/** A notification type that is not in docs/api/events/registry.json. */
export class UnregisteredNotificationTypeError extends Error {
  constructor(readonly notificationType: string) {
    super(
      `Notification type ${notificationType} is not registered in docs/api/events/registry.json`,
    );
    this.name = 'UnregisteredNotificationTypeError';
  }
}

export function buildNotificationEnvelope(
  event: NotificationEvent,
  options: EnvelopeOptions = {},
): EventEnvelope<NotificationEvent> {
  // CI keeps every emitted type registered; reaching this throw is a code
  // defect, and it fails at enqueue rather than producing an unregistered event.
  if (!(REGISTERED_NOTIFICATION_TYPES as readonly string[]).includes(event.type)) {
    throw new UnregisteredNotificationTypeError(event.type);
  }
  return {
    eventId: options.eventId ?? randomUUID(),
    type: NOTIFICATION_ENVELOPE_TYPE,
    schemaVersion: NOTIFICATION_ENVELOPE_SCHEMA_VERSION,
    producer: event.source,
    settlementId: event.correlation?.tradeId ?? null,
    // Repeats of one incident share a dedup key, so they share ordering too.
    orderingKey: event.dedupKey,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    payload: event,
  };
}
