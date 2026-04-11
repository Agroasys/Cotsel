import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertExpectedSession,
  DEFAULT_TIMEOUT_MS,
  maskSessionId,
  normalizeTimeoutMs,
} from '../lib/dashboard-operator-session.mjs';

test('normalizeTimeoutMs falls back for invalid timeout values', () => {
  assert.equal(normalizeTimeoutMs(undefined, DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeTimeoutMs('0', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeTimeoutMs('-1', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeTimeoutMs('NaN', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeTimeoutMs('1500', DEFAULT_TIMEOUT_MS), 1500);
});

test('assertExpectedSession requires the requested wallet and role', () => {
  assert.doesNotThrow(() => {
    assertExpectedSession({
      walletAddress: '0x21f8a65897e4863811b7759F8EaE84650F8E031F',
      role: 'admin',
      session: {
        walletAddress: '0x21f8a65897e4863811b7759f8eae84650f8e031f',
        role: 'admin',
      },
    });
  });

  assert.throws(
    () =>
      assertExpectedSession({
        walletAddress: '0x21f8a65897e4863811b7759F8EaE84650F8E031F',
        role: 'admin',
        session: {
          walletAddress: '0x0000000000000000000000000000000000000001',
          role: 'admin',
        },
      }),
    /wallet mismatch/,
  );

  assert.throws(
    () =>
      assertExpectedSession({
        walletAddress: '0x21f8a65897e4863811b7759F8EaE84650F8E031F',
        role: 'admin',
        session: {
          walletAddress: '0x21f8a65897e4863811b7759f8eae84650f8e031f',
          role: 'buyer',
        },
      }),
    /role mismatch/,
  );
});

test('maskSessionId redacts long bearer tokens', () => {
  assert.equal(maskSessionId(''), 'missing');
  assert.equal(maskSessionId('shorttoken'), 'shorttoken');
  assert.equal(
    maskSessionId('c8911aac37ebe24cd433f73eeddec0a5afb5427bb19db0b3a746e8ef943c0252'),
    'c8911aac...0252',
  );
});
