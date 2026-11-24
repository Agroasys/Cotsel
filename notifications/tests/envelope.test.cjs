const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NotificationOutbox,
  NOTIFICATION_ENVELOPE_TYPE,
  buildNotificationEnvelope,
} = require('../dist/index.js');
const { createEvent } = require('./outbox-fakes.cjs');

test('an envelope wraps the notification in the registered shape', () => {
  const event = createEvent();
  const occurredAt = new Date('2026-11-23T10:00:00.000Z');
  const envelope = buildNotificationEnvelope(event, { eventId: 'evt-1', occurredAt });
  assert.deepEqual(envelope, {
    eventId: 'evt-1',
    type: NOTIFICATION_ENVELOPE_TYPE,
    schemaVersion: 'v1',
    producer: event.source,
    settlementId: event.correlation.tradeId ?? null,
    orderingKey: event.dedupKey,
    occurredAt: '2026-11-23T10:00:00.000Z',
    payload: event,
  });
});

test('each envelope gets its own event id by default', () => {
  const first = buildNotificationEnvelope(createEvent());
  const second = buildNotificationEnvelope(createEvent());
  assert.match(first.eventId, /^[0-9a-f-]{36}$/u);
  assert.notEqual(first.eventId, second.eventId);
});

test('enqueue writes the envelope with the row and never rewrites it on a merge', async () => {
  const calls = [];
  const outbox = new NotificationOutbox({
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ inserted: true }] };
    },
  });
  const event = createEvent();
  assert.equal(await outbox.enqueue(event, 0), 'queued');

  const { text, values } = calls[0];
  assert.match(
    text,
    /INSERT INTO notification_outbox \(source, event_type, severity, dedup_key, event, envelope\)/u,
  );
  const envelope = JSON.parse(values[6]);
  assert.equal(envelope.type, 'cotsel.notification');
  assert.deepEqual(envelope.payload, event);
  const mergeClause = text.slice(text.indexOf('DO UPDATE SET'));
  assert.doesNotMatch(mergeClause, /envelope/u, 'a merged repeat must keep the first envelope');
});

test('an unregistered notification type is rejected, not enqueued', async () => {
  const { UnregisteredNotificationTypeError } = require('../dist/index.js');
  assert.throws(
    () => buildNotificationEnvelope(createEvent({ type: 'NOT_A_REGISTERED_TYPE' })),
    UnregisteredNotificationTypeError,
  );
  const calls = [];
  const outbox = new NotificationOutbox({
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ inserted: true }] };
    },
  });
  await assert.rejects(
    outbox.enqueue(createEvent({ type: 'NOT_A_REGISTERED_TYPE' }), 0),
    UnregisteredNotificationTypeError,
  );
  assert.equal(calls.length, 0);
});

// Review R10: an unregistered type is a deterministic validation failure, not
// an outage. It must reach neither the outbox nor any direct delivery path.
test('an unregistered type is refused before the outbox and is never delivered by fallback', async () => {
  const { DurableNotifier, WebhookNotifier } = require('../dist/index.js');
  const { silentLogger } = require('./outbox-fakes.cjs');
  const queries = [];
  const outbox = new NotificationOutbox({
    async query(text, values) {
      queries.push({ text, values });
      return { rows: [{ inserted: true }] };
    },
  });
  const delivered = [];
  const fallback = { notify: async (event) => (delivered.push(event), true) };
  const logger = silentLogger();
  const notifier = new DurableNotifier({ enabled: true, cooldownMs: 0, outbox, fallback, logger });
  const event = createEvent({ type: 'NOT_A_REGISTERED_TYPE' });

  assert.equal(await notifier.notify(event), false);
  await assert.rejects(() => notifier.enqueue(event), /not registered/u);
  assert.equal(queries.length, 0);
  assert.equal(delivered.length, 0);
  assert.ok(
    logger.entries.some(
      (entry) => entry.level === 'error' && entry.meta?.type === 'NOT_A_REGISTERED_TYPE',
    ),
  );

  let fetches = 0;
  global.fetch = async () => (fetches++, new Response('{}', { status: 200 }));
  const direct = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 0,
    requestTimeoutMs: 1000,
    retryAttempts: 1,
    retryDelayMs: 0,
    maxRetryDelayMs: 0,
    logger,
  });
  assert.equal(await direct.notify(event), false);
  assert.equal(fetches, 0);
});
