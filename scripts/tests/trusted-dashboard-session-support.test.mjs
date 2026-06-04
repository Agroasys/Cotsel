import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TIMEOUT_MS,
  maskSessionId,
  normalizeTimeoutMs,
} from '../lib/trusted-dashboard-session-support.mjs';

test('normalizeTimeoutMs falls back for invalid timeout values', () => {
  assert.equal(normalizeTimeoutMs(undefined, DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeTimeoutMs('0', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeTimeoutMs('-1', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeTimeoutMs('NaN', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeTimeoutMs('1500', DEFAULT_TIMEOUT_MS), 1500);
  assert.equal(normalizeTimeoutMs('2000', DEFAULT_TIMEOUT_MS), 2000);
  assert.equal(normalizeTimeoutMs('10000', DEFAULT_TIMEOUT_MS), 10000);
});

test('maskSessionId redacts long bearer tokens', () => {
  assert.equal(maskSessionId(''), 'missing');
  assert.equal(maskSessionId('shorttoken'), 'shorttoken');
  assert.equal(maskSessionId('123456789012'), '123456789012');
  assert.equal(maskSessionId('1234567890123'), '12345678...0123');
  assert.equal(
    maskSessionId('c8911aac37ebe24cd433f73eeddec0a5afb5427bb19db0b3a746e8ef943c0252'),
    'c8911aac...0252',
  );
});
