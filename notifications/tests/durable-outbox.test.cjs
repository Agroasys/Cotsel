const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DurableNotifier,
  NotificationDeliveryError,
  NotificationDispatcher,
  NOTIFICATION_ESCALATION_TYPE,
  NOTIFICATION_TEMPLATE_VERSIONS,
  WebhookNotifier,
  buildEscalationEvent,
  outboxRetryDelayMs,
  sanitizeDeliveryError,
} = require('../dist/index.js');

function createEvent(overrides = {}) {
  return {
    source: 'oracle',
    type: 'ORACLE_TRIGGER_TERMINAL_FAILURE',
    severity: 'critical',
    dedupKey: 'oracle:critical:trade-1',
    message: 'terminal failure',
    correlation: { tradeId: '1' },
    ...overrides,
  };
}

/**
 * An in-memory stand-in for NotificationOutbox with the same contract, so the
 * dispatcher's decisions can be tested without Postgres. The SQL itself is
 * proven against a real database in the reconciliation Postgres suite.
 */
class FakeOutbox {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }

  async enqueue(event) {
    const pending = this.rows.find(
      (row) => row.state === 'PENDING' && row.dedupKey === event.dedupKey,
    );
    if (pending) {
      pending.occurrences += 1;
      return 'merged';
    }
    this.rows.push({
      id: String(this.nextId++),
      event,
      dedupKey: event.dedupKey,
      state: 'PENDING',
      attempts: 0,
      occurrences: 1,
      lastError: null,
      leaseOwner: null,
      escalated: null,
      createdAt: new Date(),
      overdue: false,
    });
    return 'queued';
  }

  async claimDue({ owner, limit, maxAttempts }) {
    const due = this.rows
      .filter((row) => row.state === 'PENDING' && !row.leaseOwner && row.attempts < maxAttempts)
      .slice(0, limit);
    for (const row of due) {
      row.leaseOwner = owner;
      row.attempts += 1;
    }
    return due.map((row) => ({ id: row.id, event: row.event, attempts: row.attempts }));
  }

  async markDelivered(id, owner) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.leaseOwner !== owner) return false;
    row.state = 'DELIVERED';
    row.leaseOwner = null;
    return true;
  }

  async markFailed({ id, owner, error, retryDelayMs, maxAttempts }) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.leaseOwner !== owner) return null;
    row.lastError = sanitizeDeliveryError(error);
    row.lastRetryDelayMs = retryDelayMs;
    row.leaseOwner = null;
    row.state = row.attempts >= maxAttempts ? 'DEAD_LETTER' : 'PENDING';
    return row.state;
  }

  async deadLetterExhausted(maxAttempts) {
    let count = 0;
    for (const row of this.rows) {
      if (row.state === 'PENDING' && !row.leaseOwner && row.attempts >= maxAttempts) {
        row.state = 'DEAD_LETTER';
        count += 1;
      }
    }
    return count;
  }

  needsEscalation(row) {
    return (
      row.event.severity === 'critical' &&
      !row.escalated &&
      (row.state === 'DEAD_LETTER' || (row.state === 'PENDING' && row.overdue))
    );
  }

  async claimEscalations({ limit }) {
    return this.rows
      .filter((row) => this.needsEscalation(row) && !row.escalationBlocked)
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        event: row.event,
        reason: row.state === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'DELIVERY_OVERDUE',
        attempts: row.attempts,
        occurrences: row.occurrences,
        lastError: row.lastError,
        createdAt: row.createdAt,
      }));
  }

  async markEscalated(id, reason) {
    this.rows.find((row) => row.id === id).escalated = reason;
  }

  async markEscalationFailed(id, error) {
    const row = this.rows.find((candidate) => candidate.id === id);
    row.escalationError = error;
    row.escalationBlocked = true;
  }

  async stats() {
    return {
      pending: this.rows.filter((row) => row.state === 'PENDING').length,
      oldestPendingAgeMs: null,
      deadLetters: this.rows.filter((row) => row.state === 'DEAD_LETTER').length,
      awaitingEscalation: this.rows.filter((row) => this.needsEscalation(row)).length,
    };
  }
}

function recordingTransport({
  failures = 0,
  error = 'Webhook responded 503 Service Unavailable',
} = {}) {
  const transport = {
    calls: [],
    remainingFailures: failures,
    async deliver(event) {
      transport.calls.push(event);
      if (transport.remainingFailures > 0) {
        transport.remainingFailures -= 1;
        throw new NotificationDeliveryError(error);
      }
    },
  };
  return transport;
}

function silentLogger() {
  const entries = [];
  const push = (level) => (message, meta) => entries.push({ level, message, meta });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function dispatcherFor(outbox, overrides = {}) {
  return new NotificationDispatcher({
    outbox,
    transport: recordingTransport(),
    owner: 'dispatcher-a',
    maxAttempts: 3,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 8000,
    logger: silentLogger(),
    ...overrides,
  });
}

test('a notification is durable before delivery and delivered by the dispatcher', async () => {
  const outbox = new FakeOutbox();
  const transport = recordingTransport();
  const dispatcher = dispatcherFor(outbox, { transport });
  const notifier = new DurableNotifier({ enabled: true, cooldownMs: 0, outbox, dispatcher });

  assert.equal(await notifier.notify(createEvent()), true);

  assert.equal(transport.calls.length, 1);
  assert.equal(outbox.rows[0].state, 'DELIVERED');
});

test('a failed delivery stays queued with backoff and is retried by a later pass', async () => {
  const outbox = new FakeOutbox();
  const transport = recordingTransport({ failures: 1 });
  const dispatcher = dispatcherFor(outbox, { transport });

  await outbox.enqueue(createEvent());
  const first = await dispatcher.runOnce();
  assert.equal(first.retried, 1);
  assert.equal(outbox.rows[0].state, 'PENDING');
  assert.equal(outbox.rows[0].lastError, 'Webhook responded 503 Service Unavailable');
  assert.equal(outbox.rows[0].lastRetryDelayMs, 1000);

  const second = await dispatcher.runOnce();
  assert.equal(second.delivered, 1);
  assert.equal(outbox.rows[0].state, 'DELIVERED');
});

test('a notification raised during an outage survives a dispatcher restart', async () => {
  const outbox = new FakeOutbox();
  const down = dispatcherFor(outbox, { transport: recordingTransport({ failures: 10 }) });
  await outbox.enqueue(createEvent());
  await down.runOnce();
  await down.stop();
  assert.equal(outbox.rows[0].state, 'PENDING');

  const restartedTransport = recordingTransport();
  const restarted = dispatcherFor(outbox, { owner: 'dispatcher-b', transport: restartedTransport });
  await restarted.runOnce();

  assert.equal(restartedTransport.calls.length, 1);
  assert.equal(outbox.rows[0].state, 'DELIVERED');
});

test('exhausted attempts dead-letter a critical alert and page the escalation route', async () => {
  const outbox = new FakeOutbox();
  const escalation = recordingTransport();
  const dispatcher = dispatcherFor(outbox, {
    transport: recordingTransport({ failures: 10 }),
    escalationTransport: escalation,
  });
  await outbox.enqueue(createEvent());

  await dispatcher.runOnce();
  await dispatcher.runOnce();
  const last = await dispatcher.runOnce();

  assert.equal(last.deadLettered, 1);
  assert.equal(last.escalated, 1);
  assert.equal(outbox.rows[0].state, 'DEAD_LETTER');
  assert.equal(outbox.rows[0].escalated, 'DEAD_LETTER');
  assert.equal(escalation.calls.length, 1);

  const page = escalation.calls[0];
  assert.equal(page.type, NOTIFICATION_ESCALATION_TYPE);
  assert.equal(page.severity, 'critical');
  assert.equal(page.metadata.originalType, 'ORACLE_TRIGGER_TERMINAL_FAILURE');
  assert.equal(page.metadata.deliveryAttempts, 3);
  assert.deepEqual(page.correlation, { tradeId: '1' });

  await dispatcher.runOnce();
  assert.equal(escalation.calls.length, 1, 'an escalated row is not paged again');
});

test('an overdue critical alert escalates while it is still being retried', async () => {
  const outbox = new FakeOutbox();
  const escalation = recordingTransport();
  const dispatcher = dispatcherFor(outbox, {
    transport: recordingTransport({ failures: 10 }),
    escalationTransport: escalation,
    maxAttempts: 8,
  });
  await outbox.enqueue(createEvent());
  outbox.rows[0].overdue = true;

  const summary = await dispatcher.runOnce();

  assert.equal(summary.escalated, 1);
  assert.equal(outbox.rows[0].state, 'PENDING', 'primary delivery keeps retrying');
  assert.equal(escalation.calls[0].metadata.escalationReason, 'DELIVERY_OVERDUE');
});

test('a warning that dead-letters is kept but does not page the duty owner', async () => {
  const outbox = new FakeOutbox();
  const escalation = recordingTransport();
  const dispatcher = dispatcherFor(outbox, {
    transport: recordingTransport({ failures: 10 }),
    escalationTransport: escalation,
    maxAttempts: 1,
  });
  await outbox.enqueue(createEvent({ severity: 'warning', dedupKey: 'warn-1' }));

  await dispatcher.runOnce();

  assert.equal(outbox.rows[0].state, 'DEAD_LETTER');
  assert.equal(escalation.calls.length, 0);
});

test('a failed escalation is recorded and reported, not dropped', async () => {
  const outbox = new FakeOutbox();
  const logger = silentLogger();
  const dispatcher = dispatcherFor(outbox, {
    transport: recordingTransport({ failures: 10 }),
    escalationTransport: recordingTransport({
      failures: 1,
      error: 'Webhook request errored: fetch failed',
    }),
    maxAttempts: 1,
    logger,
  });
  await outbox.enqueue(createEvent());

  const summary = await dispatcher.runOnce();

  assert.equal(summary.escalationFailed, 1);
  assert.equal(outbox.rows[0].escalated, null);
  assert.equal(outbox.rows[0].escalationError, 'Webhook request errored: fetch failed');
  assert.ok(logger.entries.some((entry) => entry.message.startsWith('Could not escalate')));
});

test('without an escalation route an undeliverable critical alert is reported loudly', async () => {
  const outbox = new FakeOutbox();
  const logger = silentLogger();
  const dispatcher = dispatcherFor(outbox, {
    transport: recordingTransport({ failures: 10 }),
    maxAttempts: 1,
    logger,
  });
  await outbox.enqueue(createEvent());

  await dispatcher.runOnce();

  const report = logger.entries.find((entry) =>
    entry.message.startsWith('Critical notifications need escalation'),
  );
  assert.ok(report);
  assert.equal(report.level, 'error');
  assert.equal(report.meta.awaitingEscalation, 1);
});

test('a repeat of a pending incident merges instead of queueing a second page', async () => {
  const outbox = new FakeOutbox();
  const notifier = new DurableNotifier({ enabled: true, cooldownMs: 0, outbox });

  assert.equal(await notifier.enqueue(createEvent()), 'queued');
  assert.equal(await notifier.enqueue(createEvent()), 'merged');
  assert.equal(outbox.rows.length, 1);
  assert.equal(outbox.rows[0].occurrences, 2);
});

test('disabled notifications write nothing', async () => {
  const outbox = new FakeOutbox();
  const notifier = new DurableNotifier({ enabled: false, cooldownMs: 0, outbox });

  assert.equal(await notifier.enqueue(createEvent()), 'disabled');
  assert.equal(await notifier.notify(createEvent()), false);
  assert.equal(outbox.rows.length, 0);
});

test('enqueue throws when the outbox is unavailable so a caller can keep its own row', async () => {
  const outbox = { enqueue: async () => Promise.reject(new Error('connection refused')) };
  const notifier = new DurableNotifier({ enabled: true, cooldownMs: 0, outbox });

  await assert.rejects(() => notifier.enqueue(createEvent()), /connection refused/);
});

test('notify falls back to direct delivery when the outbox is unavailable', async () => {
  const outbox = { enqueue: async () => Promise.reject(new Error('connection refused')) };
  const sent = [];
  const fallback = { notify: async (event) => (sent.push(event), true) };
  const logger = silentLogger();
  const notifier = new DurableNotifier({ enabled: true, cooldownMs: 0, outbox, fallback, logger });

  assert.equal(await notifier.notify(createEvent()), true);
  assert.equal(sent.length, 1);
  assert.ok(logger.entries.some((entry) => entry.level === 'error'));
});

test('concurrent kicks share one pass', async () => {
  const outbox = new FakeOutbox();
  const transport = recordingTransport();
  const dispatcher = dispatcherFor(outbox, { transport });
  await outbox.enqueue(createEvent());

  const [a, b] = await Promise.all([dispatcher.runOnce(), dispatcher.runOnce()]);

  assert.equal(a, b);
  assert.equal(transport.calls.length, 1);
});

test('WebhookNotifier.deliver makes one attempt and throws on rejection', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 502, statusText: 'Bad Gateway' };
  };
  const notifier = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/secret-token',
    cooldownMs: 60_000,
    retryAttempts: 3,
  });

  await assert.rejects(
    () => notifier.deliver(createEvent()),
    (error) =>
      error instanceof NotificationDeliveryError &&
      error.message === 'Webhook responded 502 Bad Gateway' &&
      !error.message.includes('secret-token'),
  );
  assert.equal(calls, 1, 'retry belongs to the outbox, not the transport');
});

test('WebhookNotifier.deliver ignores the in-memory cooldown', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, statusText: 'OK' };
  };
  const notifier = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 60_000,
  });

  await notifier.deliver(createEvent());
  await notifier.deliver(createEvent());
  assert.equal(calls, 2);
});

test('delivery errors are stripped of URLs and bounded before they are stored', () => {
  assert.equal(
    sanitizeDeliveryError('request to https://hooks.example.invalid/T000/B000/xyz failed'),
    'request to [redacted-url] failed',
  );
  assert.equal(sanitizeDeliveryError('x'.repeat(2000)).length, 501);
});

test('retry delay doubles per attempt up to the cap', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => outboxRetryDelayMs(attempt, 1000, 5000)),
    [1000, 2000, 4000, 5000, 5000],
  );
});

test('the escalation event has a registered template version', () => {
  const page = buildEscalationEvent({
    id: '7',
    event: createEvent(),
    reason: 'DELIVERY_OVERDUE',
    attempts: 2,
    occurrences: 4,
    lastError: 'Webhook responded 500 at https://hooks.example.invalid/x',
    createdAt: new Date('2026-10-22T00:00:00Z'),
  });

  assert.equal(NOTIFICATION_TEMPLATE_VERSIONS[page.type], 'notification-escalation-v1');
  assert.equal(page.dedupKey, 'escalation:7');
  assert.equal(page.metadata.lastError, 'Webhook responded 500 at [redacted-url]');
  assert.equal(page.metadata.firstRaisedAt, '2026-10-22T00:00:00.000Z');
});
