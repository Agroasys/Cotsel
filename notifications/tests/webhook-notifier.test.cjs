const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WebhookNotifier,
  DEFAULT_TEMPLATE_VERSION,
  NOTIFICATION_ROUTING_VERSION,
  NOTIFICATION_TEMPLATE_VERSIONS,
} = require('../dist/index.js');

function createEvent(overrides = {}) {
  return {
    source: 'oracle',
    type: 'ORACLE_TRIGGER_TERMINAL_FAILURE',
    severity: 'critical',
    dedupKey: 'oracle:critical:trade-1',
    message: 'terminal failure',
    correlation: {
      tradeId: '1',
      actionKey: 'RELEASE_STAGE_1:1',
      requestId: 'req-1',
      txHash: '0x' + 'ab'.repeat(32),
    },
    metadata: {
      code: 'example',
    },
    ...overrides,
  };
}

test('retries delivery with bounded attempts and succeeds on retry', async () => {
  const calls = [];
  let attempt = 0;

  global.fetch = async () => {
    attempt += 1;
    calls.push(attempt);
    if (attempt === 1) {
      throw new Error('temporary network failure');
    }

    return { ok: true, status: 200, statusText: 'OK' };
  };

  const notifier = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 1000,
    requestTimeoutMs: 1000,
    retryAttempts: 2,
    retryDelayMs: 0,
    maxRetryDelayMs: 0,
  });

  const sent = await notifier.notify(createEvent());
  assert.equal(sent, true);
  assert.deepEqual(calls, [1, 2]);
});

test('does not exceed bounded retry ceiling', async () => {
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 500, statusText: 'Internal Server Error' };
  };

  const notifier = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 1000,
    requestTimeoutMs: 1000,
    retryAttempts: 2,
    retryDelayMs: 0,
    maxRetryDelayMs: 0,
  });

  const sent = await notifier.notify(createEvent());
  assert.equal(sent, false);
  assert.equal(attempts, 3, 'expected initial attempt plus two retries');
});

test('suppresses duplicate notifications during cooldown window', async () => {
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return { ok: true, status: 200, statusText: 'OK' };
  };

  const notifier = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 60_000,
    requestTimeoutMs: 1000,
  });

  const first = await notifier.notify(createEvent());
  const second = await notifier.notify(createEvent());

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(attempts, 1, 'expected dedup suppression to avoid second fetch call');
});

test('dedup cache is process-local and does not survive notifier restart', async () => {
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return { ok: true, status: 200, statusText: 'OK' };
  };

  const config = {
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 60_000,
    requestTimeoutMs: 1000,
  };

  const notifierA = new WebhookNotifier(config);
  const notifierB = new WebhookNotifier(config);

  const first = await notifierA.notify(createEvent());
  const second = await notifierB.notify(createEvent());

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(attempts, 2, 'expected new instance to have empty dedup cache');
});

test('embeds template version and severity route in payload', async () => {
  let sentPayload = null;
  global.fetch = async (_url, init) => {
    sentPayload = JSON.parse(init.body);
    return { ok: true, status: 200, statusText: 'OK' };
  };

  const notifier = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 1000,
    requestTimeoutMs: 1000,
  });

  const sent = await notifier.notify(createEvent());
  assert.equal(sent, true);
  assert.ok(sentPayload, 'expected payload to be sent');

  const fields = sentPayload.attachments[0].fields;
  const fieldByTitle = Object.fromEntries(fields.map((field) => [field.title, field.value]));

  assert.equal(
    fieldByTitle.templateVersion,
    NOTIFICATION_TEMPLATE_VERSIONS.ORACLE_TRIGGER_TERMINAL_FAILURE ?? DEFAULT_TEMPLATE_VERSION,
  );
  assert.equal(fieldByTitle.severityRoute, 'pager');
  assert.equal(fieldByTitle.routingVersion, NOTIFICATION_ROUTING_VERSION);
});

test('scrubs credentials, URLs and personal data from rendered webhook fields', async () => {
  let body;
  global.fetch = async (_url, init) => {
    body = init.body;
    return { ok: true, status: 200, statusText: 'OK' };
  };

  const notifier = new WebhookNotifier({
    enabled: true,
    webhookUrl: 'https://hooks.example.invalid/notify',
    cooldownMs: 1000,
    requestTimeoutMs: 1000,
    retryAttempts: 0,
  });

  const sent = await notifier.notify(
    createEvent({
      type: 'NOTIFICATION_ESCALATION',
      message: 'RPC https://base-sepolia.g.alchemy.com/v2/alchemy-key-0123456789 refused',
      metadata: {
        escalationReason: 'unacknowledged',
        originalMessage: 'contact buyer.person@example.com',
        lastError: 'Bearer sk_live_0123456789abcdef rejected',
      },
    }),
  );

  assert.equal(sent, true);
  assert.doesNotMatch(body, /alchemy-key-0123456789/);
  assert.doesNotMatch(body, /buyer\.person@example\.com/);
  assert.doesNotMatch(body, /sk_live_0123456789abcdef/);
  assert.match(body, /base-sepolia\.g\.alchemy\.com\/\[redacted\]/);
  assert.match(body, /unacknowledged/);
});
