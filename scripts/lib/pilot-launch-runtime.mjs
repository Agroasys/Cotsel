/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Launch-readiness check of a resolved gateway runtime environment against the pilot launch
 * profile (issue #613). It runs before promotion or as a container preflight, reads only the
 * environment it is given, and never contacts the chain, RPC, or any provider, so it cannot
 * broadcast or mutate settlement state.
 *
 * Diagnostics are safe to publish as evidence: secret-bearing variables are reported only as
 * missing, malformed, or present. Actual values are echoed only for the explicit allowlist of
 * non-secret identity and policy variables below.
 */

const NON_SECRET_KEYS = new Set([
  'NODE_ENV',
  'GATEWAY_SETTLEMENT_RUNTIME',
  'GATEWAY_CHAIN_ID',
  'GATEWAY_ESCROW_ADDRESS',
  'GATEWAY_USDC_ADDRESS',
  'GATEWAY_CONTRACT_ADDRESS_REQUIRED',
  'GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH',
  'GATEWAY_SETTLEMENT_INGRESS_ENABLED',
  'GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS',
  'GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS',
  'GATEWAY_SETTLEMENT_CALLBACK_ENABLED',
  'GATEWAY_IMMEDIATE_INSPECTION_ACCEPTANCE_ENABLED',
  'GATEWAY_RATE_LIMIT_ENABLED',
  'GATEWAY_RATE_LIMIT_FAIL_OPEN',
  'GATEWAY_GASLESS_EXECUTION_ENABLED',
  'GATEWAY_GASLESS_SIGNER_CUSTODY_MODE',
  'GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED',
  'GATEWAY_GASLESS_MAX_GAS_LIMIT',
  'GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI',
  'GATEWAY_GASLESS_MAX_NATIVE_COST_WEI',
]);

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

function describe(key, value) {
  if (!NON_SECRET_KEYS.has(key)) {
    return '';
  }
  return ` (found ${JSON.stringify(String(value).slice(0, 80))})`;
}

function createRuntimeCollector(env) {
  const errors = [];
  const read = (key) => {
    const value = env[key];
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const add = (key, message) => errors.push({ field: key, message });
  const present = (key) => {
    const value = read(key);
    if (!value) {
      add(key, 'is required by the pilot launch profile');
      return undefined;
    }
    return value;
  };
  const expect = (key, expected) => {
    const value = present(key);
    if (value !== undefined && value !== String(expected)) {
      add(key, `must be ${JSON.stringify(String(expected))}${describe(key, value)}`);
    }
  };
  const notTrue = (key) => {
    const value = read(key);
    if (value !== undefined && value !== '' && value !== 'false') {
      add(key, `must be unset or "false"${describe(key, value)}`);
    }
  };
  const httpsUrl = (key, value, label = key) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      add(label, 'must be an absolute URL');
      return undefined;
    }
    if (url.protocol !== 'https:') {
      add(label, 'must use https');
    }
    return url;
  };
  return { errors, read, add, present, expect, notTrue, httpsUrl };
}

function checkIdentity(r, profile) {
  const commit = r.present(profile.release?.commitEnv ?? 'GATEWAY_COMMIT_SHA');
  if (commit !== undefined && !COMMIT_PATTERN.test(commit)) {
    r.add(
      profile.release?.commitEnv ?? 'GATEWAY_COMMIT_SHA',
      'must pin the full 40-character Cotsel commit of the deployed candidate',
    );
  }
  r.expect('NODE_ENV', 'production');
  r.expect('GATEWAY_SETTLEMENT_RUNTIME', profile.network?.settlementRuntime);
  r.expect('GATEWAY_CHAIN_ID', profile.network?.chainId);
  r.expect('GATEWAY_CONTRACT_ADDRESS_REQUIRED', 'true');
  for (const [key, expected] of [
    ['GATEWAY_ESCROW_ADDRESS', profile.network?.escrowAddress],
    ['GATEWAY_USDC_ADDRESS', profile.network?.usdcAddress],
  ]) {
    const value = r.present(key);
    if (value === undefined) {
      continue;
    }
    if (!ADDRESS_PATTERN.test(value)) {
      r.add(key, `must be an EVM address${describe(key, value)}`);
    } else if (value.toLowerCase() !== String(expected).toLowerCase()) {
      r.add(key, `must be ${expected}${describe(key, value)}`);
    }
  }
}

function checkRpc(r, profile) {
  const primary = r.present('GATEWAY_RPC_URL');
  const primaryUrl = primary ? r.httpsUrl('GATEWAY_RPC_URL', primary) : undefined;
  const fallbacks = (r.read('GATEWAY_RPC_FALLBACK_URLS') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (profile.rpc?.fallbackRequired && fallbacks.length === 0) {
    r.add('GATEWAY_RPC_FALLBACK_URLS', 'must name at least one independent fallback RPC');
  }
  fallbacks.forEach((fallback, index) => {
    const label = `GATEWAY_RPC_FALLBACK_URLS[${index}]`;
    const url = r.httpsUrl(label, fallback, label);
    if (url && primaryUrl && url.host === primaryUrl.host) {
      r.add(label, 'must use a different provider host than GATEWAY_RPC_URL');
    }
  });
}

function checkServiceKeyset(r) {
  const raw = r.present('GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON');
  if (raw === undefined) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    r.add('GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON', 'must be valid JSON');
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    r.add('GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON', 'must contain at least one active key');
  }
}

function checkServiceAuth(r, profile) {
  const auth = profile.serviceAuth ?? {};
  r.expect('GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH', 'false');
  r.expect('GATEWAY_SETTLEMENT_INGRESS_ENABLED', 'true');
  r.expect(
    'GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS',
    auth.settlementIngress?.maxSkewSeconds,
  );
  r.expect(
    'GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS',
    auth.settlementIngress?.nonceTtlSeconds,
  );
  checkServiceKeyset(r);
  for (const { service } of auth.downstream ?? []) {
    const prefix = `GATEWAY_${String(service).toUpperCase().replace(/-/g, '_')}`;
    r.present(`${prefix}_BASE_URL`);
    r.present(`${prefix}_SERVICE_API_KEY`);
    r.present(`${prefix}_SERVICE_API_SECRET`);
  }
}

function checkCallback(r, profile) {
  r.expect('GATEWAY_SETTLEMENT_CALLBACK_ENABLED', 'true');
  const url = r.present('GATEWAY_SETTLEMENT_CALLBACK_URL');
  if (url !== undefined && url.replace(/\/$/, '') !== String(profile.callback?.url)) {
    r.add('GATEWAY_SETTLEMENT_CALLBACK_URL', 'must equal the callback URL pinned by the profile');
  }
  r.present('GATEWAY_SETTLEMENT_CALLBACK_API_KEY');
  r.present('GATEWAY_SETTLEMENT_CALLBACK_API_SECRET');
}

function checkCeiling(r, key, ceiling) {
  const value = r.present(key);
  if (value === undefined) {
    return;
  }
  if (!DECIMAL_PATTERN.test(value)) {
    r.add(key, `must be a canonical decimal integer${describe(key, value)}`);
  } else if (BigInt(value) > BigInt(ceiling)) {
    r.add(key, `exceeds the profile ceiling ${ceiling}${describe(key, value)}`);
  }
}

function checkSponsorship(r, profile) {
  const enabled = r.read('GATEWAY_GASLESS_EXECUTION_ENABLED');
  if (enabled !== undefined && enabled !== '' && !['true', 'false'].includes(enabled)) {
    r.add('GATEWAY_GASLESS_EXECUTION_ENABLED', 'must be "true" or "false"');
    return;
  }
  if (enabled !== 'true') {
    return;
  }
  const sponsorship = profile.sponsorship ?? {};
  if (sponsorship.approval?.status !== 'approved') {
    r.add(
      'GATEWAY_GASLESS_EXECUTION_ENABLED',
      'sponsored execution requires WP-0 approved sponsorship limits in the profile',
    );
  }
  r.expect('GATEWAY_GASLESS_SIGNER_CUSTODY_MODE', sponsorship.signerCustodyMode);
  r.expect('GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED', 'true');
  r.present('GATEWAY_GASLESS_MANAGED_SIGNER_URL');
  r.present('GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY');
  r.present('GATEWAY_GASLESS_MANAGED_SIGNER_API_SECRET');
  if (sponsorship.signerCustodyMode === 'kms') {
    const signer = r.present('GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS');
    if (signer !== undefined && !ADDRESS_PATTERN.test(signer)) {
      r.add('GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS', 'must be an EVM address');
    }
  }
  if (r.read('GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY')) {
    r.add('GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY', 'raw signer keys are not allowed in the pilot');
  }
  const ceilings = sponsorship.ceilings ?? {};
  checkCeiling(r, 'GATEWAY_GASLESS_MAX_GAS_LIMIT', ceilings.maxGasLimit);
  checkCeiling(r, 'GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI', ceilings.maxFeePerGasWei);
  checkCeiling(r, 'GATEWAY_GASLESS_MAX_NATIVE_COST_WEI', ceilings.maxNativeCostWei);
}

/**
 * Checks a resolved gateway environment against a statically valid launch profile. Returns
 * every finding so a single run produces the complete, redacted evidence record.
 */
export function checkGatewayRuntimeAgainstProfile(profile, env) {
  const r = createRuntimeCollector(env ?? {});
  checkIdentity(r, profile);
  checkRpc(r, profile);
  checkServiceAuth(r, profile);
  checkCallback(r, profile);
  r.notTrue('GATEWAY_IMMEDIATE_INSPECTION_ACCEPTANCE_ENABLED');
  r.expect('GATEWAY_RATE_LIMIT_ENABLED', 'true');
  r.expect('GATEWAY_RATE_LIMIT_FAIL_OPEN', 'false');
  checkSponsorship(r, profile);
  return { ok: r.errors.length === 0, errors: r.errors };
}

/** Minimal KEY=VALUE parser for env files; comments and blank lines are ignored. */
export function parseEnvFile(source) {
  const env = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const key = trimmed.slice(0, separator).replace(/^export\s+/, '').trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
