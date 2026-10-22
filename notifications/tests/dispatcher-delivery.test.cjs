const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createServiceNotifications,
  WebhookNotifier,
  sanitizeDeliveryError,
} = require('../dist/index.js');
const {
  FakeOutbox,
  createEvent,
  dispatcherFor,
  recordingTransport,
  silentLogger,
} = require('./outbox-fakes.cjs');

test('a pass claims one row at a time and never retries a row twice', async () => {
  const outbox = new FakeOutbox();
  const transport = recordingTransport({ failures: 10 });
  const dispatcher = dispatcherFor(outbox, { transport, maxAttempts: 8 });
  await outbox.enqueue(createEvent({ dedupKey: 'a' }));
  await outbox.enqueue(createEvent({ dedupKey: 'b' }));

  const summary = await dispatcher.runOnce();

  assert.equal(summary.retried, 2);
  assert.equal(transport.calls.length, 2, 'each row is attempted once per pass');
  assert.deepEqual(
    outbox.rows.map((row) => row.attempts),
    [1, 1],
  );
  assert.equal(outbox.claimCalls, 3, 'one claim per row plus the empty claim that ends the pass');
});

test('a disabled dispatcher sends nothing and leaves the backlog untouched', async () => {
  const outbox = new FakeOutbox();
  const transport = recordingTransport();
  const escalation = recordingTransport();
  const logger = silentLogger();
  await outbox.enqueue(createEvent());
  await outbox.enqueue(createEvent({ dedupKey: 'dead' }));
  outbox.rows[1].state = 'DEAD_LETTER';

  const dispatcher = dispatcherFor(outbox, {
    enabled: false,
    transport,
    escalationTransport: escalation,
    logger,
  });
  await dispatcher.runOnce();
  await dispatcher.runOnce();

  assert.equal(transport.calls.length, 0);
  assert.equal(escalation.calls.length, 0);
  assert.equal(outbox.rows[0].state, 'PENDING');
  assert.equal(outbox.rows[0].attempts, 0, 'no attempt is spent while disabled');
  const reports = logger.entries.filter((entry) =>
    entry.message.startsWith('Notifications are disabled'),
  );
  assert.equal(reports.length, 1, 'the retained backlog is reported once');
  assert.deepEqual(reports[0].meta, { pending: 1, deadLetters: 1 });
});

test('createServiceNotifications with notifications disabled does not drain a queued backlog', async () => {
  const queries = [];
  const executor = {
    async query(text) {
      queries.push(text);
      // Only the backlog report is answered: one critical row is still queued.
      return {
        rows: [
          {
            pending: '1',
            oldest_pending_age_ms: '1000',
            dead_letters: '0',
            awaiting_escalation: '1',
          },
        ],
      };
    },
  };
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, statusText: 'OK' };
  };

  const { dispatcher } = createServiceNotifications({
    enabled: false,
    webhookUrl: 'https://hooks.example.invalid/primary',
    escalationWebhookUrl: 'https://hooks.example.invalid/escalation',
    cooldownMs: 0,
    requestTimeoutMs: 1000,
    executor,
    logger: silentLogger(),
  });
  await dispatcher.runOnce();

  assert.equal(calls, 0);
  assert.ok(queries.length > 0);
  assert.equal(
    queries.some((text) => /^\s*UPDATE/i.test(text)),
    false,
    'no row is claimed, failed or dead-lettered while disabled',
  );
});

test('the escalation webhook body carries the original alert context', async () => {
  const outbox = new FakeOutbox();
  const bodies = [];
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, statusText: 'OK' };
  };
  const dispatcher = dispatcherFor(outbox, {
    transport: recordingTransport({
      failures: 10,
      error: 'request to https://hooks.example.invalid/T0/B0/secret failed',
    }),
    escalationTransport: new WebhookNotifier({
      enabled: true,
      webhookUrl: 'https://hooks.example.invalid/escalation',
      cooldownMs: 0,
    }),
    maxAttempts: 1,
  });
  await outbox.enqueue(
    createEvent({ message: 'Settlement trigger 42 failed terminally.', metadata: { secret: 'x' } }),
  );

  await dispatcher.runOnce();

  assert.equal(bodies.length, 1);
  const fields = Object.fromEntries(
    bodies[0].attachments[0].fields.map((field) => [field.title, field.value]),
  );
  assert.match(bodies[0].text, /NOTIFICATION_ESCALATION/);
  assert.equal(fields.originalMessage, 'Settlement trigger 42 failed terminally.');
  assert.equal(fields.originalType, 'ORACLE_TRIGGER_TERMINAL_FAILURE');
  assert.equal(fields.originalDedupKey, 'oracle:critical:trade-1');
  assert.equal(fields.escalationReason, 'DEAD_LETTER');
  assert.equal(fields.outboxId, '1');
  assert.equal(fields.deliveryAttempts, '1');
  assert.equal(fields.lastError, 'request to [redacted-url] failed');
  assert.equal(fields.tradeId, '1');
  assert.ok(fields.firstRaisedAt);
  assert.equal(fields.secret, undefined, 'original metadata is not forwarded');
  assert.equal(JSON.stringify(bodies[0]).includes('secret failed'), false);
});

test('ordinary alerts still keep metadata out of the webhook body', async () => {
  let body = null;
  global.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, statusText: 'OK' };
  };
  const notifier = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 0,
  });

  await notifier.deliver(
    createEvent({ metadata: { originalMessage: 'smuggled', lastError: 'x' } }),
  );

  const titles = body.attachments[0].fields.map((field) => field.title);
  assert.equal(titles.includes('originalMessage'), false);
  assert.equal(titles.includes('lastError'), false);
});

test('error sanitization stays linear on adversarial input', () => {
  const hostile = 'a'.repeat(200_000) + ' ' + 'a:'.repeat(100_000);
  const started = process.hrtime.bigint();
  const result = sanitizeDeliveryError(hostile);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(elapsedMs < 500, `took ${elapsedMs}ms`);
  assert.equal(result.length, 501);
  assert.equal(
    sanitizeDeliveryError('a https://x.invalid/t b\tftp://y.invalid c'),
    'a [redacted-url] b\t[redacted-url] c',
  );
});
