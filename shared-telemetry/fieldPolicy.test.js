'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TELEMETRY_FIELD_POLICY, classifyTelemetryField, isProhibitedField } = require('./index');

const REPO_ROOT = path.resolve(__dirname, '..');

function backtickedFieldsInSection(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  const end = markdown.indexOf(endHeading, start + startHeading.length);
  assert.ok(start >= 0 && end > start, `missing section ${startHeading}`);
  return [...markdown.slice(start, end).matchAll(/^\|\s*`([A-Za-z]+)`/gmu)].map(
    (match) => match[1],
  );
}

test('no classified field is also prohibited', () => {
  const conflicts = [...TELEMETRY_FIELD_POLICY.keys()].filter((name) => isProhibitedField(name));
  assert.deepEqual(conflicts, []);
});

test('every AuditEnvelopeV1 field in the logging schema is classified', () => {
  const schema = fs.readFileSync(
    path.join(REPO_ROOT, 'docs/observability/logging-schema.md'),
    'utf8',
  );
  const fields = backtickedFieldsInSection(
    schema,
    '## Standard Audit Envelope v1',
    '### Sensitive-data rule',
  );
  assert.ok(fields.length >= 20, 'expected the AuditEnvelopeV1 field tables');

  const unclassified = fields.filter((name) => !TELEMETRY_FIELD_POLICY.has(name));
  assert.deepEqual(unclassified, []);
});

test('fields the data-classification policy prohibits are never classified', () => {
  const guard = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts/tests/data-classification-guard.mjs'),
    'utf8',
  );
  const banned = guard
    .slice(
      guard.indexOf('const BANNED_FIELD_NAMES'),
      guard.indexOf('];', guard.indexOf('const BANNED_FIELD_NAMES')),
    )
    .match(/'([A-Za-z]+)'/gu)
    .map((quoted) => quoted.slice(1, -1));
  assert.ok(banned.length > 10);

  for (const name of banned) {
    assert.equal(classifyTelemetryField(name), 'prohibited', name);
  }
});

test('credential-shaped names are prohibited however they are spelled', () => {
  for (const name of [
    'ORACLE_PRIVATE_KEY',
    'gatewayHmacSecret',
    'dbPassword',
    'sessionCookie',
    'x-authorization',
    'awsCredentials',
    'token',
    'signature',
  ]) {
    assert.equal(classifyTelemetryField(name), 'prohibited', name);
  }
});

test('references that merely mention a credential concept stay usable', () => {
  for (const name of ['apiKeyId', 'exchangeKeyId', 'signatureHash', 'keyPrefix', 'signatureRef']) {
    assert.notEqual(classifyTelemetryField(name), 'prohibited', name);
    assert.notEqual(classifyTelemetryField(name), 'unclassified', name);
  }
});

test('an unknown field is unclassified', () => {
  assert.equal(classifyTelemetryField('buyerLegalName'), 'unclassified');
});

test('export job references are internal while tokens remain prohibited', () => {
  assert.equal(classifyTelemetryField('exportId'), 'internal_operational');
  assert.equal(classifyTelemetryField('token'), 'prohibited');
});
