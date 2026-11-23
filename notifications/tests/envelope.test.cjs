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
