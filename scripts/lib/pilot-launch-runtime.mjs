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
import { createRequire } from 'node:module';
import { isIP } from 'node:net';

// The gateway parses its settlement keyset with this function; reusing it keeps the launch check
// and the runtime from disagreeing about what counts as a usable key.
const { parseServiceApiKeys } = createRequire(import.meta.url)(
  '../../shared-auth/src/serviceAuth.js',
);
const RAW_SIGNER_KEY_VARIABLES = ['GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY', 'GATEWAY_EXECUTOR_PRIVATE_KEY'];

const NON_SECRET_KEYS = new Set([
  'NODE_ENV',
  'GATEWAY_COMMIT_SHA',
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

function checkIdentity(r, profile, { candidateCommit, requirePromotable }) {
  const commitEnv = profile.release?.commitEnv ?? 'GATEWAY_COMMIT_SHA';
  const commit = r.present(commitEnv);
  if (commit !== undefined && !COMMIT_PATTERN.test(commit)) {
    r.add(commitEnv, 'must pin the full 40-character Cotsel commit of the deployed candidate');
  }
  if (!candidateCommit || !COMMIT_PATTERN.test(candidateCommit)) {
    r.add(
      'candidateCommit',
      'a full 40-character candidate commit is required (--candidate-commit or GITHUB_SHA)',
    );
  } else if (commit !== undefined && COMMIT_PATTERN.test(commit) && commit !== candidateCommit) {
    r.add(commitEnv, `must equal the candidate commit being promoted${describe(commitEnv, commit)}`);
  }
  if (requirePromotable && candidateCommit !== profile.acceptance?.candidateCommit) {
    r.add('candidateCommit', 'must equal the candidate commit recorded in the profile acceptance');
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

/**
 * Approximates the provider by the last two hostname labels, so two hostnames of one provider
 * (e.g. regional or numbered endpoints) do not count as independent. IP literals compare whole.
 * This can over-reject public-suffix hosts such as example.co.uk, which fails safe.
 */
function providerDomain(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) {
    return host;
  }
  return host.split('.').filter(Boolean).slice(-2).join('.');
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
    if (url && primaryUrl && providerDomain(url.hostname) === providerDomain(primaryUrl.hostname)) {
      r.add(label, 'must use a different provider domain than GATEWAY_RPC_URL');
    }
  });
}

function checkServiceKeyset(r) {
  const raw = r.present('GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON');
  if (raw === undefined) {
    return;
  }
  let keys;
  try {
    keys = parseServiceApiKeys(raw);
  } catch (error) {
    // The parser's messages name fields only; anything else is replaced so no value can leak.
    const reason = /^API_KEYS_JSON[\w[\].]* /.test(error.message) ? `: ${error.message}` : '';
    r.add('GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON', `must be a valid service keyset${reason}`);
    return;
  }
  if (!keys.some((key) => key.active && key.id && key.secret)) {
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
  if (r.read('GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET')) {
    r.add(
      'GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET',
      'must be unset; the pilot accepts only the rotatable keyset form of settlement auth',
    );
  }
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
  // Raw keys are refused whether or not sponsorship is enabled: the gateway reads either name.
  for (const key of RAW_SIGNER_KEY_VARIABLES) {
    if (r.read(key)) {
      r.add(key, 'raw signer keys are not allowed in the pilot');
    }
  }
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
  const ceilings = sponsorship.ceilings ?? {};
  checkCeiling(r, 'GATEWAY_GASLESS_MAX_GAS_LIMIT', ceilings.maxGasLimit);
  checkCeiling(r, 'GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI', ceilings.maxFeePerGasWei);
  checkCeiling(r, 'GATEWAY_GASLESS_MAX_NATIVE_COST_WEI', ceilings.maxNativeCostWei);
}

/**
 * Checks a resolved gateway environment against a statically valid launch profile and the
 * candidate commit being promoted. Under `requirePromotable` the candidate must also be the one
 * the profile acceptance names. Returns every finding so one run is the complete, redacted record.
 */
export function checkGatewayRuntimeAgainstProfile(
  profile,
  env,
  { candidateCommit, requirePromotable = false } = {},
) {
  const r = createRuntimeCollector(env ?? {});
  checkIdentity(r, profile, { candidateCommit, requirePromotable });
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
