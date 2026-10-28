'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REDACTED,
  maskNetworkAddress,
  sanitizeTelemetryRecord,
  serializeTelemetryRecord,
} = require('./index');

// Seeded sensitive values. None of them may survive serialization.
const SEEDS = {
  privateKey: '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
  pem: '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBkg4LVWM9nuwNSk3yByxZpYRTBnVJk5oWtBTZOkJgWRoAoGCCqGSM49\n-----END EC PRIVATE KEY-----',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVlLXNlY3JldA',
  bearer: 'Bearer sk_live_0123456789abcdef',
  rpcKey: 'alchemy-key-0123456789',
  dbPassword: 'pg-password-0123',
  webhookToken: 'T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX',
  email: 'buyer.person@example.com',
  iban: 'GB82WEST12345698765432',
  ip: '203.0.113.77',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) seeded-agent',
  mnemonic: 'test test test test test test test test test test test junk',
};

function assertNoSeeds(serialized) {
  for (const [name, seed] of Object.entries(SEEDS)) {
    assert.ok(!serialized.includes(seed), `seeded ${name} leaked: ${serialized}`);
  }
}

test('prohibited field names are redacted at any depth', () => {
  const record = sanitizeTelemetryRecord({
    message: 'signer configured',
    privateKey: SEEDS.privateKey,
    details: {
      authorization: SEEDS.bearer,
      hmacSecret: 'hmac-secret-value',
      nested: { mnemonic: SEEDS.mnemonic },
    },
    accessToken: SEEDS.jwt,
    userAgent: SEEDS.userAgent,
  });

  assert.equal(record.privateKey, REDACTED);
  assert.equal(record.accessToken, REDACTED);
  assert.equal(record.userAgent, REDACTED);
  assert.equal(record.details.authorization, REDACTED);
  assert.equal(record.details.hmacSecret, REDACTED);
  assertNoSeeds(JSON.stringify(record));
});

test('unclassified fields are dropped and named, never emitted', () => {
  const record = sanitizeTelemetryRecord({
    message: 'trade locked',
    tradeId: 'trade-1',
    buyerLegalName: 'Seeded Person Ltd',
    payload: { amount: '100', subject: { fullName: 'Seeded Person' } },
    details: { stage: 'indexer-anchor', postalAddress: '1 Seed Street' },
  });

  assert.equal(record.tradeId, 'trade-1');
  assert.equal(record.details.stage, 'indexer-anchor');
  assert.equal('buyerLegalName' in record, false);
  assert.equal('payload' in record, false);
  assert.equal('postalAddress' in record.details, false);
  assert.deepEqual(record.telemetryDroppedFields, [
    'buyerLegalName',
    'details.postalAddress',
    'payload',
  ]);
  assert.doesNotMatch(JSON.stringify(record), /Seeded Person|Seed Street/);
});

test('non-identifier field names are not echoed into the dropped list', () => {
  const record = sanitizeTelemetryRecord({ [SEEDS.email]: true });
  assert.deepEqual(record.telemetryDroppedFields, ['<non-identifier>']);
  assertNoSeeds(JSON.stringify(record));
});

test('free text is scrubbed for credentials, URLs, email addresses and IBANs', () => {
  const record = sanitizeTelemetryRecord({
    message: `Got 429 from https://base-sepolia.g.alchemy.com/v2/${SEEDS.rpcKey}`,
    error: [
      `connect postgres://cotsel:${SEEDS.dbPassword}@db.internal:5432/cotsel failed`,
      `webhook https://hooks.slack.com/services/${SEEDS.webhookToken} rejected`,
      `header was ${SEEDS.bearer}`,
      `token ${SEEDS.jwt} expired`,
      `notify ${SEEDS.email}`,
      `payout to ${SEEDS.iban}`,
      `key material ${SEEDS.pem}`,
    ].join('; '),
  });

  const serialized = JSON.stringify(record);
  assertNoSeeds(serialized);
  assert.match(
    record.message,
    /^Got 429 from https:\/\/base-sepolia\.g\.alchemy\.com\/\[redacted\]$/,
  );
  assert.match(record.error, /postgres:\/\/db\.internal:5432\/\[redacted\]/);
  assert.match(record.error, /Bearer \[REDACTED\]/);
  assert.match(record.error, /\[REDACTED:jwt\]/);
  assert.match(record.error, /\[REDACTED:email\]/);
  assert.match(record.error, /\[REDACTED:iban\]/);
  assert.match(record.error, /\[REDACTED:private-key\]/);
});

test('operational identifiers are not mistaken for sensitive values', () => {
  const txHash = '0x' + 'ab'.repeat(32);
  const record = sanitizeTelemetryRecord({
    message: 'GET /api/dashboard-gateway/v1/trades/TR12345678901234568',
    tradeId: 'TR12345678901234568',
    txHash,
    signerAddress: '0x52908400098527886E0F7030069857D2E4169EE7',
    route: '/api/v1/settlements/:tradeId',
    statusCode: 200,
    retryable: false,
  });

  assert.equal(record.tradeId, 'TR12345678901234568');
  assert.equal(record.txHash, txHash);
  assert.equal(record.message, 'GET /api/dashboard-gateway/v1/trades/TR12345678901234568');
  assert.equal(record.statusCode, 200);
  assert.equal(record.retryable, false);
  assert.equal(record.telemetryDroppedFields, undefined);
});

test('endpoint fields keep only the origin', () => {
  const record = sanitizeTelemetryRecord({
    rpcUrl: `https://base-sepolia.g.alchemy.com/v2/${SEEDS.rpcKey}`,
    fallbackRpcUrls: [
      `https://user:${SEEDS.dbPassword}@rpc.example:8545/`,
      'https://rpc.public.example',
    ],
    indexerGraphqlUrl: 'http://indexer-graphql:4350/graphql',
  });

  assert.equal(record.rpcUrl, 'https://base-sepolia.g.alchemy.com/[redacted]');
  assert.deepEqual(record.fallbackRpcUrls, [
    'https://rpc.example:8545/[redacted]',
    'https://rpc.public.example',
  ]);
  assert.equal(record.indexerGraphqlUrl, 'http://indexer-graphql:4350/[redacted]');
  assertNoSeeds(JSON.stringify(record));
});

test('client network addresses are truncated to a network prefix', () => {
  assert.equal(maskNetworkAddress(SEEDS.ip), '203.0.113.0/24');
  assert.equal(maskNetworkAddress(`::ffff:${SEEDS.ip}`), '203.0.113.0/24');
  assert.equal(maskNetworkAddress('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::/48');
  assert.equal(maskNetworkAddress('::1'), '0:0:0::/48');
  assert.equal(maskNetworkAddress('not-an-ip'), REDACTED);
  assert.equal(sanitizeTelemetryRecord({ ip: SEEDS.ip }).ip, '203.0.113.0/24');
});

test('errors, bigints, dates, binary and cycles serialize safely', () => {
  const error = new Error(`Got 429 from https://rpc.example/v3/${SEEDS.rpcKey}`);
  const cyclic = { stage: 'loop' };
  cyclic.details = cyclic;

  const record = sanitizeTelemetryRecord({
    err: error,
    blockNumber: 45807259n,
    startedAt: new Date('2026-10-27T00:00:00.000Z'),
    req: Buffer.from('raw request body'),
    details: cyclic,
    reason: () => 'ignored',
  });

  assert.match(record.err, /^Error: Got 429 from https:\/\/rpc\.example\/\[redacted\]/);
  assert.equal(record.blockNumber, '45807259');
  assert.equal(record.startedAt, '2026-10-27T00:00:00.000Z');
  assert.equal(record.req, '[binary]');
  assert.equal(record.details.details, '[circular]');
  assert.equal('reason' in record, false);
  assertNoSeeds(JSON.stringify(record));
});

test('oversized values are bounded', () => {
  const record = sanitizeTelemetryRecord({
    error: 'x'.repeat(10_000),
    errors: Array.from({ length: 80 }, (_, index) => `e${index}`),
  });

  assert.ok(record.error.length < 4200);
  assert.match(record.error, /\.\.\.\[truncated\]$/);
  assert.equal(record.errors.length, 51);
  assert.equal(record.errors[50], '[30 more]');
});

test('a non-object record becomes a scrubbed message', () => {
  assert.deepEqual(sanitizeTelemetryRecord(`login ${SEEDS.email}`), {
    message: 'login [REDACTED:email]',
  });
});

test('serializeTelemetryRecord emits sanitized JSON', () => {
  const serialized = serializeTelemetryRecord({
    level: 'info',
    message: 'request',
    ip: SEEDS.ip,
    refreshToken: SEEDS.jwt,
  });
  assertNoSeeds(serialized);
  assert.deepEqual(JSON.parse(serialized), {
    level: 'info',
    message: 'request',
    ip: '203.0.113.0/24',
    refreshToken: REDACTED,
  });
});

test('request paths drop the query string and fragment', () => {
  const record = sanitizeTelemetryRecord({
    route: '/trades?api_key=demo-secret&phone=15551234567',
    path: `/settlements/42#${SEEDS.jwt}`,
    endpoint: '/api/dashboard-gateway/v1/trades',
  });

  assert.equal(record.route, '/trades?[redacted]');
  assert.equal(record.path, '/settlements/42?[redacted]');
  assert.equal(record.endpoint, '/api/dashboard-gateway/v1/trades');
  assert.doesNotMatch(JSON.stringify(record), /demo-secret|15551234567/);
  assertNoSeeds(JSON.stringify(record));
});

test('relative request targets in free text lose their query string', () => {
  const record = sanitizeTelemetryRecord({
    message: 'GET /trades?api_key=demo-secret&phone=15551234567 failed',
    error: 'redirected to (/login?next=/trades) is it ok? yes / no?',
    stack: 'Error: boom\n    at handler (/app/gateway/dist/routes/trades.js:10:5)',
  });

  assert.equal(record.message, 'GET /trades?[redacted] failed');
  assert.equal(record.error, 'redirected to (/login?[redacted]) is it ok? yes / no?');
  assert.equal(
    record.stack,
    'Error: boom\n    at handler (/app/gateway/dist/routes/trades.js:10:5)',
  );
});

test('sanitizing a sanitized record changes nothing', () => {
  const once = sanitizeTelemetryRecord({
    route: '/trades?api_key=demo-secret',
    message: `GET /trades?x=1 via https://rpc.example/v2/${SEEDS.rpcKey}`,
    ip: SEEDS.ip,
  });
  assert.deepEqual(sanitizeTelemetryRecord(once), once);
});
