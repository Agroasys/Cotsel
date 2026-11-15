import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPilotLaunchInputs } from '../lib/pilot-launch-profile.mjs';
import { checkGatewayRuntimeAgainstProfile, parseEnvFile } from '../lib/pilot-launch-runtime.mjs';
import { run } from '../validate-pilot-launch-profile.mjs';

const { profile } = loadPilotLaunchInputs();
const SECRET = 'sk-test-DO-NOT-PRINT-7f3a';

function approvedProfile() {
  const approved = structuredClone(profile);
  approved.sponsorship.approval = {
    status: 'approved',
    authority: 'WP-0',
    evidence: 'https://github.com/Agroasys/Cotsel/issues/613#issuecomment-1',
  };
  return approved;
}

function runtimeEnv(overrides = {}) {
  const env = {
    NODE_ENV: 'production',
    GATEWAY_COMMIT_SHA: 'a'.repeat(40),
    GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
    GATEWAY_CHAIN_ID: '84532',
    GATEWAY_CONTRACT_ADDRESS_REQUIRED: 'true',
    GATEWAY_ESCROW_ADDRESS: profile.network.escrowAddress.toLowerCase(),
    GATEWAY_USDC_ADDRESS: profile.network.usdcAddress,
    GATEWAY_RPC_URL: `https://primary.rpc.example/v2/${SECRET}`,
    GATEWAY_RPC_FALLBACK_URLS: `https://fallback.rpc.example/${SECRET}`,
    GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH: 'false',
    GATEWAY_SETTLEMENT_INGRESS_ENABLED: 'true',
    GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS: '300',
    GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS: '600',
    GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON: JSON.stringify([{ id: 'k1', secret: SECRET }]),
    GATEWAY_SETTLEMENT_CALLBACK_ENABLED: 'true',
    GATEWAY_SETTLEMENT_CALLBACK_URL: profile.callback.url,
    GATEWAY_SETTLEMENT_CALLBACK_API_KEY: 'callback-key',
    GATEWAY_SETTLEMENT_CALLBACK_API_SECRET: SECRET,
    GATEWAY_RATE_LIMIT_ENABLED: 'true',
    GATEWAY_RATE_LIMIT_FAIL_OPEN: 'false',
    GATEWAY_GASLESS_EXECUTION_ENABLED: 'false',
  };
  for (const service of ['ORACLE', 'TREASURY', 'RICARDIAN']) {
    env[`GATEWAY_${service}_BASE_URL`] = `http://${service.toLowerCase()}.internal`;
    env[`GATEWAY_${service}_SERVICE_API_KEY`] = `${service.toLowerCase()}-key`;
    env[`GATEWAY_${service}_SERVICE_API_SECRET`] = SECRET;
  }
  return { ...env, ...overrides };
}

function gaslessEnv(overrides = {}) {
  return runtimeEnv({
    GATEWAY_GASLESS_EXECUTION_ENABLED: 'true',
    GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'kms',
    GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED: 'true',
    GATEWAY_GASLESS_MANAGED_SIGNER_URL: 'http://relayer.internal:3300',
    GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY: 'relayer-key',
    GATEWAY_GASLESS_MANAGED_SIGNER_API_SECRET: SECRET,
    GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS: `0x${'3'.repeat(40)}`,
    GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500000',
    GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '50000000',
    GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '100000000000000',
    ...overrides,
  });
}

function fields(result) {
  return result.errors.map((error) => error.field);
}

function assertNoSecretLeak(result) {
  assert.ok(!JSON.stringify(result).includes(SECRET), 'diagnostics must not echo secrets');
}

test('a runtime matching the profile passes', () => {
  assert.deepEqual(checkGatewayRuntimeAgainstProfile(profile, runtimeEnv()).errors, []);
  assert.deepEqual(checkGatewayRuntimeAgainstProfile(approvedProfile(), gaslessEnv()).errors, []);
});

test('wrong chain, drifted contract and stale release identity fail closed', () => {
  for (const [overrides, field] of [
    [{ GATEWAY_CHAIN_ID: '8453' }, 'GATEWAY_CHAIN_ID'],
    [{ GATEWAY_SETTLEMENT_RUNTIME: 'base-mainnet' }, 'GATEWAY_SETTLEMENT_RUNTIME'],
    [{ GATEWAY_ESCROW_ADDRESS: `0x${'4'.repeat(40)}` }, 'GATEWAY_ESCROW_ADDRESS'],
    [{ GATEWAY_USDC_ADDRESS: 'not-an-address' }, 'GATEWAY_USDC_ADDRESS'],
    [{ GATEWAY_COMMIT_SHA: 'local-dev' }, 'GATEWAY_COMMIT_SHA'],
    [{ GATEWAY_CONTRACT_ADDRESS_REQUIRED: 'false' }, 'GATEWAY_CONTRACT_ADDRESS_REQUIRED'],
    [{ NODE_ENV: 'development' }, 'NODE_ENV'],
  ]) {
    const result = checkGatewayRuntimeAgainstProfile(profile, runtimeEnv(overrides));
    assert.deepEqual(fields(result), [field], field);
  }
});

test('RPC outage posture requires an independent https fallback', () => {
  const missing = checkGatewayRuntimeAgainstProfile(
    profile,
    runtimeEnv({ GATEWAY_RPC_FALLBACK_URLS: '' }),
  );
  assert.deepEqual(fields(missing), ['GATEWAY_RPC_FALLBACK_URLS']);

  const sameHost = checkGatewayRuntimeAgainstProfile(
    profile,
    runtimeEnv({ GATEWAY_RPC_FALLBACK_URLS: `https://primary.rpc.example/other/${SECRET}` }),
  );
  assert.deepEqual(fields(sameHost), ['GATEWAY_RPC_FALLBACK_URLS[0]']);
  assertNoSecretLeak(sameHost);

  const plaintext = checkGatewayRuntimeAgainstProfile(
    profile,
    runtimeEnv({ GATEWAY_RPC_URL: `http://primary.rpc.example/${SECRET}` }),
  );
  assert.deepEqual(fields(plaintext), ['GATEWAY_RPC_URL']);
  assertNoSecretLeak(plaintext);
});

test('missing service auth, insecure auth and callback mismatch fail closed', () => {
  for (const [overrides, field] of [
    [{ GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON: '' }, 'GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON'],
    [
      { GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON: '[]' },
      'GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON',
    ],
    [
      { GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON: `{${SECRET}` },
      'GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON',
    ],
    [{ GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH: 'true' }, 'GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH'],
    [
      { GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS: '900' },
      'GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS',
    ],
    [{ GATEWAY_ORACLE_SERVICE_API_SECRET: undefined }, 'GATEWAY_ORACLE_SERVICE_API_SECRET'],
    [
      { GATEWAY_SETTLEMENT_CALLBACK_URL: 'https://evil.example/cb' },
      'GATEWAY_SETTLEMENT_CALLBACK_URL',
    ],
    [{ GATEWAY_SETTLEMENT_CALLBACK_API_SECRET: '  ' }, 'GATEWAY_SETTLEMENT_CALLBACK_API_SECRET'],
    [
      { GATEWAY_IMMEDIATE_INSPECTION_ACCEPTANCE_ENABLED: 'true' },
      'GATEWAY_IMMEDIATE_INSPECTION_ACCEPTANCE_ENABLED',
    ],
    [{ GATEWAY_RATE_LIMIT_FAIL_OPEN: 'true' }, 'GATEWAY_RATE_LIMIT_FAIL_OPEN'],
  ]) {
    const result = checkGatewayRuntimeAgainstProfile(profile, runtimeEnv(overrides));
    assert.deepEqual(fields(result), [field], field);
    assertNoSecretLeak(result);
  }
});

test('sponsored execution requires approved limits, managed custody and caps within ceilings', () => {
  assert.deepEqual(fields(checkGatewayRuntimeAgainstProfile(profile, gaslessEnv())), [
    'GATEWAY_GASLESS_EXECUTION_ENABLED',
  ]);
  for (const [overrides, field] of [
    [
      { GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'raw_private_key' },
      'GATEWAY_GASLESS_SIGNER_CUSTODY_MODE',
    ],
    [{ GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY: SECRET }, 'GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY'],
    [{ GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED: 'false' }, 'GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED'],
    [{ GATEWAY_GASLESS_MAX_GAS_LIMIT: '1500001' }, 'GATEWAY_GASLESS_MAX_GAS_LIMIT'],
    [{ GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI: '1e9' }, 'GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI'],
    [
      { GATEWAY_GASLESS_MAX_NATIVE_COST_WEI: '100000000000001' },
      'GATEWAY_GASLESS_MAX_NATIVE_COST_WEI',
    ],
    [{ GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS: '' }, 'GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS'],
    [
      { GATEWAY_GASLESS_MANAGED_SIGNER_API_SECRET: undefined },
      'GATEWAY_GASLESS_MANAGED_SIGNER_API_SECRET',
    ],
  ]) {
    const result = checkGatewayRuntimeAgainstProfile(approvedProfile(), gaslessEnv(overrides));
    assert.deepEqual(fields(result), [field], field);
    assertNoSecretLeak(result);
  }
  assert.deepEqual(
    fields(
      checkGatewayRuntimeAgainstProfile(
        profile,
        runtimeEnv({ GATEWAY_GASLESS_EXECUTION_ENABLED: 'yes' }),
      ),
    ),
    ['GATEWAY_GASLESS_EXECUTION_ENABLED'],
  );
});

test('an empty environment reports every required value without throwing', () => {
  const result = checkGatewayRuntimeAgainstProfile(profile, {});
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 20);
  assert.ok(fields(result).includes('GATEWAY_CHAIN_ID'));
  assert.ok(fields(result).includes('GATEWAY_SETTLEMENT_CALLBACK_API_SECRET'));
});

test('env files are parsed and the CLI report stays redacted', () => {
  const env = runtimeEnv({ GATEWAY_CHAIN_ID: '1' });
  const lines = [
    '# pilot gateway',
    ...Object.entries(env).map(([key, value]) => `${key}="${value}"`),
  ];
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pilot-launch-'));
  const file = path.join(directory, 'gateway.env');
  writeFileSync(file, `${lines.join('\n')}\n`);
  assert.equal(parseEnvFile(readFileSync(file, 'utf8')).GATEWAY_CHAIN_ID, '1');

  const { ok, report } = run(['--env-file', file]);
  assert.equal(ok, false);
  assert.deepEqual(fields(report.runtime), ['GATEWAY_CHAIN_ID']);
  assert.ok(!JSON.stringify(report).includes(SECRET));

  const fromProcess = run(['--runtime-env'], { env: runtimeEnv() });
  assert.equal(fromProcess.ok, true);
});
