// Must come first: the database modules below load src/config.ts on import,
// which asserts a complete configuration before any test body runs.
import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  NotificationDeliveryError,
  NotificationDispatcher,
  NotificationOutbox,
  type NotificationEvent,
  type NotificationLogger,
  type NotificationTransport,
} from '@agroasys/notifications';
import {
  RUNTIME_ROLE,
  createAdminPool,
  dockerAvailable,
  scenarioRunner,
  withPostgresContainer,
  type AdminPool,
} from './helpers/reconciliationPostgres';

const quietLogger: NotificationLogger = { info() {}, warn() {}, error() {} };

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    source: 'reconciliation',
    type: 'RECONCILIATION_CRITICAL_DRIFT',
    severity: 'critical',
    dedupKey: 'reconciliation:critical:7:STATUS_MISMATCH',
    message: 'Critical reconciliation drift detected between on-chain and indexed trade state.',
    correlation: { tradeId: '7', runKey: 'daemon-1' },
    ...overrides,
  };
}

class Transport implements NotificationTransport {
  readonly delivered: NotificationEvent[] = [];
  constructor(private failing = false) {}

  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  async deliver(notification: NotificationEvent): Promise<void> {
    if (this.failing) {
      throw new NotificationDeliveryError('Webhook responded 503 Service Unavailable');
    }
    this.delivered.push(notification);
  }
}

function dispatcher(
  outbox: NotificationOutbox,
  transport: NotificationTransport,
  overrides: Partial<ConstructorParameters<typeof NotificationDispatcher>[0]> = {},
): NotificationDispatcher {
  return new NotificationDispatcher({
    outbox,
    transport,
    owner: 'dispatcher-a',
    maxAttempts: 3,
    // A retry is due immediately, so each pass is one attempt.
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    logger: quietLogger,
    ...overrides,
  });
}

async function rows(pool: Pool): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query(
    `SELECT id::text, state, attempts, occurrences, last_error, escalated_at, escalation_reason,
            escalation_attempts
     FROM notification_outbox ORDER BY id`,
  );
  return result.rows;
}

test(
  'durable notification outbox (H-26)',
  { timeout: 300_000, skip: !dockerAvailable },
  async (t) => {
    await withPostgresContainer(async ({ port }: { port: number }) => {
      const admin: AdminPool = await createAdminPool(port);
      try {
        await admin.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
        const scenario = scenarioRunner(t, port, admin, 'outbox');

        await scenario(
          'an alert raised during an outage is delivered after a restart',
          async (pool) => {
            const outbox = new NotificationOutbox(pool);
            const down = new Transport(true);
            assert.equal(await outbox.enqueue(event(), 0), 'queued');

            const first = dispatcher(outbox, down);
            const summary = await first.runOnce();
            await first.stop();
            assert.equal(summary.retried, 1);
            assert.deepEqual(
              (await rows(pool)).map((row) => [row.state, row.attempts, row.last_error]),
              [['PENDING', 1, 'Webhook responded 503 Service Unavailable']],
            );

            // A new process with a new dispatcher identity and a working webhook.
            const up = new Transport();
            await dispatcher(new NotificationOutbox(pool), up, { owner: 'dispatcher-b' }).runOnce();

            assert.equal(up.delivered.length, 1);
            assert.equal(up.delivered[0].dedupKey, event().dedupKey);
            assert.equal((await rows(pool))[0].state, 'DELIVERED');
          },
        );

        await scenario(
          'a repeat merges into the pending row and cooldown survives a restart',
          async (pool) => {
            const outbox = new NotificationOutbox(pool);
            assert.equal(await outbox.enqueue(event(), 60_000), 'queued');
            assert.equal(await outbox.enqueue(event(), 60_000), 'merged');
            assert.equal((await rows(pool))[0].occurrences, 2);

            await dispatcher(outbox, new Transport()).runOnce();

            // A fresh outbox instance, as after a restart: still suppressed.
            assert.equal(await new NotificationOutbox(pool).enqueue(event(), 60_000), 'suppressed');
            // Without a cooldown the same incident pages again.
            assert.equal(await outbox.enqueue(event(), 0), 'queued');
            assert.equal((await rows(pool)).length, 2);
          },
        );

        await scenario(
          'two dispatchers draining together deliver each alert once',
          async (pool) => {
            const outbox = new NotificationOutbox(pool);
            for (let index = 0; index < 40; index += 1) {
              await outbox.enqueue(event({ dedupKey: `drift:${index}` }), 0);
            }

            const a = new Transport();
            const b = new Transport();
            await Promise.all([
              dispatcher(outbox, a, { owner: 'a', batchSize: 7 }).runOnce(),
              dispatcher(outbox, b, { owner: 'b', batchSize: 7 }).runOnce(),
              dispatcher(outbox, a, { owner: 'a2', batchSize: 7 }).runOnce(),
              dispatcher(outbox, b, { owner: 'b2', batchSize: 7 }).runOnce(),
            ]);
            // Drain what the bounded batches left.
            while ((await dispatcher(outbox, a, { owner: 'tail' }).runOnce()).delivered > 0) {
              // keep draining
            }

            const keys = [...a.delivered, ...b.delivered].map(
              (notification) => notification.dedupKey,
            );
            assert.equal(keys.length, 40);
            assert.equal(new Set(keys).size, 40, 'no alert was sent twice');
          },
        );

        await scenario(
          'exhausted attempts dead-letter and page the duty owner once',
          async (pool) => {
            const outbox = new NotificationOutbox(pool);
            const escalation = new Transport();
            const run = dispatcher(outbox, new Transport(true), {
              escalationTransport: escalation,
            });
            await outbox.enqueue(event(), 0);

            await run.runOnce();
            await run.runOnce();
            const last = await run.runOnce();

            assert.equal(last.deadLettered, 1);
            assert.equal(last.escalated, 1);
            const [row] = await rows(pool);
            assert.equal(row.state, 'DEAD_LETTER');
            assert.equal(row.attempts, 3);
            assert.equal(row.escalation_reason, 'DEAD_LETTER');
            assert.ok(row.escalated_at instanceof Date);
            assert.equal(escalation.delivered.length, 1);
            assert.equal(
              escalation.delivered[0].metadata?.originalType,
              'RECONCILIATION_CRITICAL_DRIFT',
            );

            await run.runOnce();
            assert.equal(escalation.delivered.length, 1, 'escalated rows are not paged twice');
            assert.deepEqual(await run.stats(), {
              pending: 0,
              oldestPendingAgeMs: null,
              deadLetters: 1,
              awaitingEscalation: 0,
            });
          },
        );

        await scenario(
          'an overdue critical alert escalates while it keeps retrying',
          async (pool) => {
            const outbox = new NotificationOutbox(pool);
            const escalation = new Transport();
            await outbox.enqueue(event(), 0);
            await pool.query(
              `UPDATE notification_outbox SET created_at = NOW() - INTERVAL '20 minutes'`,
            );

            const summary = await dispatcher(outbox, new Transport(true), {
              escalationTransport: escalation,
              maxAttempts: 8,
              escalateAfterMs: 600_000,
            }).runOnce();

            assert.equal(summary.escalated, 1);
            const [row] = await rows(pool);
            assert.equal(row.state, 'PENDING');
            assert.equal(row.escalation_reason, 'DELIVERY_OVERDUE');
            assert.equal(escalation.delivered[0].metadata?.escalationReason, 'DELIVERY_OVERDUE');
          },
        );

        await scenario('a failed escalation is retried on a later pass', async (pool) => {
          const outbox = new NotificationOutbox(pool);
          const escalation = new Transport(true);
          const run = dispatcher(outbox, new Transport(true), {
            escalationTransport: escalation,
            maxAttempts: 1,
          });
          await outbox.enqueue(event(), 0);

          assert.equal((await run.runOnce()).escalationFailed, 1);
          assert.equal((await rows(pool))[0].escalated_at, null);

          escalation.setFailing(false);
          await pool.query(`UPDATE notification_outbox SET escalation_next_attempt_at = NOW()`);
          assert.equal((await run.runOnce()).escalated, 1);
          assert.equal((await rows(pool))[0].escalation_attempts, 2);
        });

        await scenario(
          'a worker that dies on the final attempt still dead-letters',
          async (pool) => {
            const outbox = new NotificationOutbox(pool);
            await outbox.enqueue(event(), 0);
            const [claimed] = await outbox.claimDue({
              owner: 'crashed',
              leaseMs: 60_000,
              limit: 1,
              maxAttempts: 1,
            });
            assert.equal(claimed.attempts, 1);

            // The lease outlives the crash, so nothing else may take the row yet.
            assert.equal(await outbox.deadLetterExhausted(1), 0);
            await pool.query(
              `UPDATE notification_outbox SET lease_expires_at = NOW() - INTERVAL '1 second'`,
            );
            assert.equal(await outbox.deadLetterExhausted(1), 1);

            const [row] = await rows(pool);
            assert.equal(row.state, 'DEAD_LETTER');
            assert.equal(row.last_error, 'Delivery lease expired on the final attempt');
          },
        );

        await scenario('a dispatcher that lost its lease cannot settle the row', async (pool) => {
          const outbox = new NotificationOutbox(pool);
          await outbox.enqueue(event(), 0);
          const [claimed] = await outbox.claimDue({
            owner: 'slow',
            leaseMs: 60_000,
            limit: 1,
            maxAttempts: 3,
          });
          await pool.query(
            `UPDATE notification_outbox SET lease_expires_at = NOW() - INTERVAL '1 second'`,
          );
          await outbox.claimDue({ owner: 'successor', leaseMs: 60_000, limit: 1, maxAttempts: 3 });

          assert.equal(await outbox.markDelivered(claimed.id, 'slow'), false);
          assert.equal(
            await outbox.markFailed({
              id: claimed.id,
              owner: 'slow',
              error: 'late',
              retryDelayMs: 1,
              maxAttempts: 3,
            }),
            null,
          );
          assert.equal(await outbox.markDelivered(claimed.id, 'successor'), true);
        });

        await scenario(
          'settled rows are immutable evidence the runtime role cannot delete',
          async (pool) => {
            const outbox = new NotificationOutbox(pool);
            await outbox.enqueue(event(), 0);
            await dispatcher(outbox, new Transport()).runOnce();

            await assert.rejects(
              pool.query(`UPDATE notification_outbox SET state = 'PENDING', delivered_at = NULL`),
              /notification_outbox_settled_row_is_immutable/,
            );

            const client = await pool.connect();
            try {
              await client.query(`SET ROLE ${RUNTIME_ROLE}`);
              await assert.rejects(
                client.query('DELETE FROM notification_outbox'),
                /permission denied/,
              );
              const visible = await client.query(
                'SELECT COUNT(*)::int AS count FROM notification_outbox',
              );
              assert.equal(visible.rows[0].count, 1);
            } finally {
              await client.query('RESET ROLE');
              client.release();
            }
          },
        );

        await scenario(
          'a notification enqueued in a rolled-back transaction never pages',
          async (pool) => {
            const outbox = new NotificationOutbox(pool);
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              assert.equal(await outbox.enqueue(event(), 0, client), 'queued');
              await client.query('ROLLBACK');
            } finally {
              client.release();
            }

            assert.deepEqual(await rows(pool), []);
          },
        );
      } finally {
        await admin.end();
      }
    });
  },
);
