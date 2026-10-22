import type { NotificationEvent, NotificationSeverity } from './index';

/**
 * Durable custody for outbound notifications (SOW H-26).
 *
 * A notification is written here before any delivery is attempted, so a webhook
 * outage, a crash between raising and sending, or a restart cannot lose it. The
 * row is the evidence: it records every attempt, the last failure, whether it
 * dead-lettered, and whether the duty owner was escalated to.
 *
 * Each consuming service creates the `notification_outbox` table in its own
 * versioned migration; the column contract is the one these queries use.
 */

export const NOTIFICATION_OUTBOX_TABLE = 'notification_outbox';

export type OutboxState = 'PENDING' | 'DELIVERED' | 'DEAD_LETTER';
export type EscalationReason = 'DEAD_LETTER' | 'DELIVERY_OVERDUE';
export type EnqueueResult = 'queued' | 'merged' | 'suppressed';

/**
 * The slice of a `pg` Pool or PoolClient the outbox needs. Kept structural so
 * this library does not take a database driver dependency of its own.
 */
export interface OutboxQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface ClaimedNotification {
  id: string;
  event: NotificationEvent;
  attempts: number;
}

export interface ClaimedEscalation {
  id: string;
  event: NotificationEvent;
  reason: EscalationReason;
  attempts: number;
  occurrences: number;
  lastError: string | null;
  createdAt: Date;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeMs: number | null;
  deadLetters: number;
  awaitingEscalation: number;
}

interface ClaimRow {
  id: string;
  event: NotificationEvent;
  attempts: number;
}

interface EscalationRow extends ClaimRow {
  reason: EscalationReason;
  occurrences: number;
  last_error: string | null;
  created_at: Date;
}

interface StatsRow {
  pending: string;
  oldest_pending_age_ms: string | null;
  dead_letters: string;
  awaiting_escalation: string;
}

const SEVERITIES: readonly NotificationSeverity[] = ['info', 'warning', 'critical'];
const MAX_ERROR_LENGTH = 500;

/**
 * Bound a failure message before it is persisted or forwarded.
 *
 * Transport errors are produced by this library and do not carry the webhook
 * URL, but an upstream message is not trusted to stay that way: anything shaped
 * like a URL is removed, because a webhook URL is a credential.
 */
export function sanitizeDeliveryError(message: string): string {
  const redacted = message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted-url]');
  return redacted.length > MAX_ERROR_LENGTH ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…` : redacted;
}

function assertEvent(event: NotificationEvent): void {
  if (!SEVERITIES.includes(event.severity)) {
    throw new Error(`Unsupported notification severity: ${String(event.severity)}`);
  }
  if (!event.dedupKey) {
    throw new Error('A durable notification requires a dedupKey');
  }
}

export class NotificationOutbox {
  constructor(private readonly executor: OutboxQueryExecutor) {}

  /**
   * Record a notification for delivery.
   *
   * A pending row with the same `dedupKey` absorbs the repeat as an occurrence
   * instead of queueing a second page for the same incident. A repeat inside
   * `cooldownMs` of a delivered one is suppressed, which is the old in-memory
   * cooldown made durable: it now survives a restart instead of re-paging.
   *
   * Pass the executor of an open transaction to make the notification commit
   * or roll back with the state it describes.
   */
  async enqueue(
    event: NotificationEvent,
    cooldownMs: number,
    executor: OutboxQueryExecutor = this.executor,
  ): Promise<EnqueueResult> {
    assertEvent(event);
    const result = await executor.query(
      `INSERT INTO notification_outbox (source, event_type, severity, dedup_key, event)
       SELECT $1, $2, $3, $4, $5::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM notification_outbox
         WHERE dedup_key = $4
           AND state = 'DELIVERED'
           AND delivered_at > NOW() - ($6::bigint * INTERVAL '1 millisecond')
       )
       ON CONFLICT (dedup_key) WHERE state = 'PENDING'
       DO UPDATE SET
         occurrences = notification_outbox.occurrences + 1,
         last_seen_at = NOW(),
         event = EXCLUDED.event
       RETURNING (xmax = 0) AS inserted`,
      [
        event.source,
        event.type,
        event.severity,
        event.dedupKey,
        JSON.stringify(event),
        Math.max(0, Math.trunc(cooldownMs)),
      ],
    );

    const row = result.rows[0] as { inserted: boolean } | undefined;
    if (!row) {
      return 'suppressed';
    }
    return row.inserted ? 'queued' : 'merged';
  }

  /**
   * Lease due notifications to one dispatcher.
   *
   * `SKIP LOCKED` lets several replicas drain the same outbox without sending a
   * row twice, and the attempt is counted at claim time so a worker that dies
   * mid-delivery still spends one of the row's bounded attempts. Critical rows
   * are taken first.
   */
  async claimDue(input: {
    owner: string;
    leaseMs: number;
    limit: number;
    maxAttempts: number;
  }): Promise<ClaimedNotification[]> {
    const result = await this.executor.query(
      `UPDATE notification_outbox
       SET lease_owner = $1,
           lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
           attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM notification_outbox
         WHERE state = 'PENDING'
           AND attempts < $4
           AND next_attempt_at <= NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id::text AS id, event, attempts`,
      [input.owner, input.leaseMs, input.limit, input.maxAttempts],
    );

    return (result.rows as ClaimRow[]).map((row) => ({
      id: row.id,
      event: row.event,
      attempts: row.attempts,
    }));
  }

  /** Fenced on the lease, so a dispatcher that lost its lease cannot settle a row. */
  async markDelivered(id: string, owner: string): Promise<boolean> {
    const result = await this.executor.query(
      `UPDATE notification_outbox
       SET state = 'DELIVERED', delivered_at = NOW(), last_error = NULL,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1::bigint AND lease_owner = $2 AND state = 'PENDING'
       RETURNING id`,
      [id, owner],
    );
    return result.rows.length === 1;
  }

  /**
   * Record a failed attempt: back off, or dead-letter once the attempts are spent.
   * A dead letter stays in the table as evidence and is never retried silently.
   */
  async markFailed(input: {
    id: string;
    owner: string;
    error: string;
    retryDelayMs: number;
    maxAttempts: number;
  }): Promise<OutboxState | null> {
    const result = await this.executor.query(
      `UPDATE notification_outbox
       SET state = CASE WHEN attempts >= $5 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
           dead_lettered_at = CASE WHEN attempts >= $5 THEN NOW() ELSE NULL END,
           next_attempt_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
           last_error = $3,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = $1::bigint AND lease_owner = $2 AND state = 'PENDING'
       RETURNING state`,
      [
        input.id,
        input.owner,
        sanitizeDeliveryError(input.error),
        input.retryDelayMs,
        input.maxAttempts,
      ],
    );
    const row = result.rows[0] as { state: OutboxState } | undefined;
    return row?.state ?? null;
  }

  /**
   * Dead-letter rows whose last attempt never reported back.
   *
   * A dispatcher that dies holding a row on its final attempt leaves it PENDING
   * with no attempts left, which `claimDue` will never take again. Without this
   * the row would sit unclaimed and unescalated forever.
   */
  async deadLetterExhausted(maxAttempts: number): Promise<number> {
    const result = await this.executor.query(
      `UPDATE notification_outbox
       SET state = 'DEAD_LETTER',
           dead_lettered_at = NOW(),
           last_error = COALESCE(last_error, 'Delivery lease expired on the final attempt'),
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE state = 'PENDING'
         AND attempts >= $1
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
       RETURNING id`,
      [maxAttempts],
    );
    return result.rows.length;
  }

  /**
   * Lease critical rows that need the duty owner.
   *
   * A critical row escalates when it dead-letters, or when it is still
   * undelivered `escalateAfterMs` after it was raised. The claim pushes the
   * row's next escalation attempt forward by the lease, so a crashed dispatcher
   * delays a retry rather than losing it.
   */
  async claimEscalations(input: {
    escalateAfterMs: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedEscalation[]> {
    const result = await this.executor.query(
      `UPDATE notification_outbox
       SET escalation_attempts = escalation_attempts + 1,
           escalation_next_attempt_at = NOW() + ($2::bigint * INTERVAL '1 millisecond')
       WHERE id IN (
         SELECT id FROM notification_outbox
         WHERE severity = 'critical'
           AND escalated_at IS NULL
           AND (
             state = 'DEAD_LETTER'
             OR (state = 'PENDING' AND created_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond'))
           )
           AND (escalation_next_attempt_at IS NULL OR escalation_next_attempt_at <= NOW())
         ORDER BY id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id::text AS id, event, attempts, occurrences, last_error, created_at,
         CASE WHEN state = 'DEAD_LETTER' THEN 'DEAD_LETTER' ELSE 'DELIVERY_OVERDUE' END AS reason`,
      [input.escalateAfterMs, input.leaseMs, input.limit],
    );

    return (result.rows as EscalationRow[]).map((row) => ({
      id: row.id,
      event: row.event,
      reason: row.reason,
      attempts: row.attempts,
      occurrences: row.occurrences,
      lastError: row.last_error,
      createdAt: row.created_at,
    }));
  }

  async markEscalated(id: string, reason: EscalationReason): Promise<void> {
    await this.executor.query(
      `UPDATE notification_outbox
       SET escalated_at = NOW(), escalation_reason = $2, escalation_last_error = NULL
       WHERE id = $1::bigint AND escalated_at IS NULL`,
      [id, reason],
    );
  }

  async markEscalationFailed(id: string, error: string, retryDelayMs: number): Promise<void> {
    await this.executor.query(
      `UPDATE notification_outbox
       SET escalation_last_error = $2,
           escalation_next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
       WHERE id = $1::bigint AND escalated_at IS NULL`,
      [id, sanitizeDeliveryError(error), retryDelayMs],
    );
  }

  /** Backlog and failure counts for readiness, metrics and the release gate. */
  async stats(escalateAfterMs: number): Promise<OutboxStats> {
    const result = await this.executor.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'PENDING')::text AS pending,
         (EXTRACT(EPOCH FROM NOW() - MIN(created_at) FILTER (WHERE state = 'PENDING')) * 1000)::bigint::text
           AS oldest_pending_age_ms,
         COUNT(*) FILTER (WHERE state = 'DEAD_LETTER')::text AS dead_letters,
         COUNT(*) FILTER (
           WHERE severity = 'critical'
             AND escalated_at IS NULL
             AND (
               state = 'DEAD_LETTER'
               OR created_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')
             )
         )::text AS awaiting_escalation
       FROM notification_outbox
       WHERE state <> 'DELIVERED'`,
      [escalateAfterMs],
    );
    const row = result.rows[0] as StatsRow;
    return {
      pending: Number(row.pending),
      oldestPendingAgeMs:
        row.oldest_pending_age_ms === null ? null : Number(row.oldest_pending_age_ms),
      deadLetters: Number(row.dead_letters),
      awaitingEscalation: Number(row.awaiting_escalation),
    };
  }
}
