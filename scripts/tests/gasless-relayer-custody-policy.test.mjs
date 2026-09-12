import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCapacityReport } from '../gasless-relayer-capacity-rehearsal.mjs';

const MANAGED_ENV = {
  NODE_ENV: 'production',
  GATEWAY_CHAIN_ID: '84532',
  GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'kms',
  GATEWAY_GASLESS_MANAGED_SIGNER_URL: 'http://relayer.cotsel-staging.internal:3300',
  GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY: 'gateway',
  GATEWAY_GASLESS_MANAGED_SIGNER_API_SECRET: 'secret',
  GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
  GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1000000000',
  GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '2000000000000000',
  GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '200000000000000000',
  GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '200000000000000000',
  GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
};

function report(overrides = {}) {
  const snapshot = { ...process.env };
  process.env = { ...snapshot, ...MANAGED_ENV, ...overrides };
  try {
    return buildCapacityReport(
      { mode: 'config-only', output: 'unused.json', evidenceFile: null },
      new Date('2026-09-12T00:00:00.000Z'),
    );
  } finally {
    process.env = snapshot;
  }
}

test('accepts HMAC-authenticated private relayer transport without gateway KMS custody', () => {
  const result = report({ GATEWAY_GASLESS_KMS_KEY_ID: '' });
  assert.equal(result.blockers.length, 0, result.blockers.join('\n'));
  assert.equal(result.controls.managedSignerApiSecretConfigured, true);
  assert.equal(result.controls.gatewayKmsKeyIdConfigured, false);
});

test('rejects missing HMAC secret or a gateway-visible KMS key ID', () => {
  assert.match(
    report({ GATEWAY_GASLESS_MANAGED_SIGNER_API_SECRET: '' }).blockers.join('\n'),
    /requires a managed signer API secret/,
  );
  assert.match(
    report({ GATEWAY_GASLESS_KMS_KEY_ID: 'alias/cotsel-staging-relayer' }).blockers.join('\n'),
    /gateway must not receive the relayer KMS key ID/,
  );
});
