import crypto from 'node:crypto';

export const CANDIDATE_ID_PATTERN = /^cotsel-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]{4,16}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
export const ISSUE_PATTERN = /^https:\/\/github\.com\/Agroasys\/[A-Za-z0-9._-]+\/issues\/[0-9]+$/;
export const CONTROL_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,23}$/;
export const ROUTE_PATTERN = /^wp[0-9]{1,2}-[a-z0-9-]+$/;
export const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._@/+-]{1,63}$/;

export const ENVIRONMENTS = ['local-ci', 'base-sepolia-staging', 'base-mainnet'];
export const PROVIDER_MODES = {
  fiatOffRamp: ['disabled', 'sandbox', 'live'],
  signer: ['local-key', 'kms', 'mpc'],
  rpc: ['single', 'primary-with-fallback'],
};
export const ACCEPTANCE_ROLES = ['Release Owner', 'Security reviewer', 'Operations reviewer'];
export const REVIEW_DECISIONS = ['accepted', 'rejected', 'pending'];
export const BASE_MAINNET_CHAIN_ID = 8453;

export function failManifest(message) {
  throw new Error(`Candidate manifest invalid: ${message}`);
}

export function failIndex(message) {
  throw new Error(`Evidence index invalid: ${message}`);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function requireString(fail, value, name, pattern) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} is required`);
  }
  if (pattern && !pattern.test(value)) {
    fail(`${name} does not match ${pattern}`);
  }
  return value;
}

export function requireEnum(fail, value, name, allowed) {
  if (!allowed.includes(value)) {
    fail(`${name} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

export function requireInteger(fail, value, name, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

export function requireTimestamp(fail, value, name) {
  requireString(fail, value, name);
  if (Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 timestamp`);
  }
  return value;
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalDigest(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function normalizeProviderMode(providerMode) {
  return {
    fiatOffRamp: providerMode.fiatOffRamp,
    signer: providerMode.signer,
    rpc: providerMode.rpc,
  };
}

export function validateProviderMode(providerMode, fail, name) {
  if (!isPlainObject(providerMode)) {
    fail(`${name} is required`);
  }
  for (const [field, allowed] of Object.entries(PROVIDER_MODES)) {
    requireEnum(fail, providerMode[field], `${name}.${field}`, allowed);
  }
  for (const key of Object.keys(providerMode)) {
    if (!(key in PROVIDER_MODES)) {
      fail(`${name}.${key} is not a recognized provider dimension`);
    }
  }
}
