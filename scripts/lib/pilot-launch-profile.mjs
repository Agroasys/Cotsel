/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Static validation for the Cotsel controlled-pilot launch profile (SOW 3.3/3.4, issue #613).
 * The profile pins the non-secret boundary of one Cotsel pilot environment: release identity
 * source, chain and contract identity, RPC mode, service-auth and callback contracts, sponsorship
 * ceilings, feature flags, surface exposure and side-effect-free readiness probes. Secrets are
 * referenced by name only; a profile that embeds a URL credential or key material is rejected.
 *
 * Every rule appends to a diagnostics list instead of throwing, so one run reports every
 * problem. Diagnostics name fields and expectations only; they never echo secret material.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DECISION_EVIDENCE_PATTERN, validateAcceptance } from './pilot-launch-acceptance.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(LIB_DIR, '../..');
export const DEFAULT_PROFILE_PATH = 'integration/base-sepolia-pilot-launch-profile.json';

export const PROFILE_SCHEMA_VERSION = 'cotsel.pilot-launch-profile.v1';
const PROFILE_STATUSES = ['pending-acceptance', 'accepted', 'withdrawn'];
const ENVIRONMENTS = ['aws-staging'];
const RPC_MODES = ['managed-primary-with-fallback'];
const CUSTODY_MODES = ['kms', 'mpc'];
const APPROVAL_STATUSES = ['pending', 'approved'];
const EXPOSURES = ['cloudfront-waf', 'private', 'loopback'];
const ROLLBACK_TARGETS = ['previous-accepted-candidate'];
const READ_ONLY_METHODS = ['GET', 'HEAD'];
const GASLESS_READINESS = ['gasless-relayer', 'gasless-relayer-policy'];
const MANDATORY_UNSUPPORTED = [
  'base-mainnet',
  'raw-private-key-signer-custody',
  'oracle-only-inspection-acceptance',
];

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SECRET_REF_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
const DECIMAL_WEI_PATTERN = /^[1-9][0-9]*$/;
const SERVICE_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
const SOW_PATTERN = /^[0-9]+\.[0-9]+$/;
const GITHUB_ISSUE_PATTERN = /^https:\/\/github\.com\/Agroasys\/[A-Za-z0-9.-]+\/issues\/[0-9]+$/;
const REPO_PATH_PATTERN = /^[a-z0-9][a-z0-9./-]*\.json$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readRepositoryJson(relativePath, rootDir = ROOT_DIR) {
  return JSON.parse(fs.readFileSync(path.resolve(rootDir, relativePath), 'utf8'));
}

function createCollector() {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const object = (value, field) => {
    if (!isPlainObject(value)) {
      add(field, 'must be an object');
      return {};
    }
    return value;
  };
  const enumValue = (value, allowed, field) => {
    if (!allowed.includes(value)) {
      add(field, `must be one of ${allowed.join(', ')}`);
    }
  };
  const equal = (value, expected, field, source) => {
    if (value !== expected) {
      add(field, `must equal the value pinned by ${source}`);
    }
  };
  const pattern = (value, regex, field, description) => {
    if (typeof value !== 'string' || !regex.test(value)) {
      add(field, `must be ${description}`);
      return false;
    }
    return true;
  };
  const bool = (value, field) => {
    if (typeof value !== 'boolean') {
      add(field, 'must be a boolean');
    }
  };
  const positiveInteger = (value, field) => {
    if (!Number.isSafeInteger(value) || value < 1) {
      add(field, 'must be a positive integer');
    }
  };
  return { errors, add, object, enumValue, equal, pattern, bool, positiveInteger };
}

function sameAddress(left, right) {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function validateTraceability(c, profile) {
  const traceability = c.object(profile.traceability, 'traceability');
  c.pattern(traceability.issue, GITHUB_ISSUE_PATTERN, 'traceability.issue', 'a GitHub issue URL');
  c.pattern(
    traceability.programme,
    GITHUB_ISSUE_PATTERN,
    'traceability.programme',
    'a GitHub issue URL',
  );
  if (
    !Array.isArray(traceability.sow) ||
    traceability.sow.length === 0 ||
    !traceability.sow.every((entry) => SOW_PATTERN.test(entry))
  ) {
    c.add('traceability.sow', 'must list the SOW rows this profile implements');
  }
}

function validateRelease(c, profile, authorityRegistry, rootDir) {
  const release = c.object(profile.release, 'release');
  c.equal(
    release.commitSource,
    'gateway_image_tag',
    'release.commitSource',
    'the staging Terraform (GATEWAY_COMMIT_SHA = var.gateway_image_tag)',
  );
  c.equal(release.commitEnv, 'GATEWAY_COMMIT_SHA', 'release.commitEnv', 'the gateway image');
  c.enumValue(release.rollbackTarget, ROLLBACK_TARGETS, 'release.rollbackTarget');
  if (
    c.pattern(
      release.candidateManifestSchema,
      REPO_PATH_PATTERN,
      'release.candidateManifestSchema',
      'a repository JSON path',
    ) &&
    !fs.existsSync(path.resolve(rootDir, release.candidateManifestSchema))
  ) {
    c.add('release.candidateManifestSchema', 'must reference a file that exists');
  }
  const authority = authorityRegistry?.profiles?.find(
    (entry) => entry.profileId === release.authorityProfileId,
  );
  if (!authority) {
    c.add('release.authorityProfileId', 'must name a release authority profile');
  } else if (authority.promotionPolicy !== 'named-two-person') {
    c.add('release.authorityProfileId', 'must name a promotable two-person authority profile');
  }
}

function validateNetwork(c, profile, stagingContract) {
  const network = c.object(profile.network, 'network');
  const source = network.contractIdentity ?? 'the accepted contract identity';
  c.equal(network.settlementRuntime, 'base-sepolia', 'network.settlementRuntime', 'the SDK');
  c.pattern(network.contractIdentity, REPO_PATH_PATTERN, 'network.contractIdentity', 'a path');
  c.pattern(network.escrowAddress, ADDRESS_PATTERN, 'network.escrowAddress', 'an EVM address');
  c.pattern(network.usdcAddress, ADDRESS_PATTERN, 'network.usdcAddress', 'an EVM address');
  c.positiveInteger(network.deploymentBlock, 'network.deploymentBlock');
  c.pattern(
    network.normalizedRuntimeBytecodeSha256,
    SHA256_PATTERN,
    'network.normalizedRuntimeBytecodeSha256',
    'a SHA-256 digest',
  );
  if (!stagingContract) {
    c.add('network.contractIdentity', 'must resolve to a readable contract identity');
    return;
  }
  if (stagingContract.acceptance?.decision !== 'ACCEPTED') {
    c.add('network.contractIdentity', 'must reference an ACCEPTED contract identity');
  }
  c.equal(network.chainId, stagingContract.chainId, 'network.chainId', source);
  if (!sameAddress(network.escrowAddress, stagingContract.address)) {
    c.add('network.escrowAddress', `must equal the address pinned by ${source}`);
  }
  if (!sameAddress(network.usdcAddress, stagingContract.usdcAddress)) {
    c.add('network.usdcAddress', `must equal the USDC address pinned by ${source}`);
  }
  c.equal(
    network.deploymentBlock,
    stagingContract.deploymentBlock,
    'network.deploymentBlock',
    source,
  );
  c.equal(
    network.normalizedRuntimeBytecodeSha256,
    stagingContract.artifact?.normalizedRuntimeBytecodeSha256,
    'network.normalizedRuntimeBytecodeSha256',
    source,
  );
}

function validateSecretRef(c, value, field) {
  c.pattern(value, SECRET_REF_PATTERN, field, 'a secret reference name, not a secret value');
}

function validateRpcAndAuth(c, profile) {
  const rpc = c.object(profile.rpc, 'rpc');
  c.enumValue(rpc.mode, RPC_MODES, 'rpc.mode');
  validateSecretRef(c, rpc.primarySecretRef, 'rpc.primarySecretRef');
  validateSecretRef(c, rpc.fallbackSecretRef, 'rpc.fallbackSecretRef');
  c.equal(rpc.fallbackRequired, true, 'rpc.fallbackRequired', 'the pilot RPC policy');
  if (rpc.primarySecretRef && rpc.primarySecretRef === rpc.fallbackSecretRef) {
    c.add('rpc.fallbackSecretRef', 'must differ from rpc.primarySecretRef');
  }

  const auth = c.object(profile.serviceAuth, 'serviceAuth');
  c.equal(
    auth.insecureDownstreamAuthAllowed,
    false,
    'serviceAuth.insecureDownstreamAuthAllowed',
    'the production security profile',
  );
  const ingress = c.object(auth.settlementIngress, 'serviceAuth.settlementIngress');
  c.equal(ingress.enabled, true, 'serviceAuth.settlementIngress.enabled', 'the pilot boundary');
  validateSecretRef(c, ingress.keysetSecretRef, 'serviceAuth.settlementIngress.keysetSecretRef');
  c.positiveInteger(ingress.maxSkewSeconds, 'serviceAuth.settlementIngress.maxSkewSeconds');
  c.positiveInteger(ingress.nonceTtlSeconds, 'serviceAuth.settlementIngress.nonceTtlSeconds');
  if (Number.isSafeInteger(ingress.maxSkewSeconds) && ingress.maxSkewSeconds > 300) {
    c.add('serviceAuth.settlementIngress.maxSkewSeconds', 'must not exceed 300 seconds');
  }
  if (
    Number.isSafeInteger(ingress.maxSkewSeconds) &&
    Number.isSafeInteger(ingress.nonceTtlSeconds) &&
    ingress.nonceTtlSeconds < ingress.maxSkewSeconds * 2
  ) {
    c.add(
      'serviceAuth.settlementIngress.nonceTtlSeconds',
      'must cover the full accepted skew window (at least twice maxSkewSeconds)',
    );
  }
  if (!Array.isArray(auth.downstream) || auth.downstream.length === 0) {
    c.add('serviceAuth.downstream', 'must list every authenticated downstream service');
  } else {
    auth.downstream.forEach((entry, index) => {
      c.pattern(entry?.service, SERVICE_PATTERN, `serviceAuth.downstream[${index}].service`, 'a name');
      validateSecretRef(c, entry?.secretRef, `serviceAuth.downstream[${index}].secretRef`);
    });
  }
}

function validateCallback(c, profile, releaseManifest) {
  const callback = c.object(profile.callback, 'callback');
  c.equal(callback.enabled, true, 'callback.enabled', 'the pilot boundary');
  c.equal(
    callback.contract,
    releaseManifest?.contracts?.settlementCallback,
    'callback.contract',
    'integration/release-manifest.json',
  );
  c.equal(
    callback.observedAmountsContract,
    releaseManifest?.contracts?.observedAmounts,
    'callback.observedAmountsContract',
    'integration/release-manifest.json',
  );
  validateSecretRef(c, callback.credentialSecretRef, 'callback.credentialSecretRef');
  let url;
  try {
    url = new URL(callback.url);
  } catch {
    c.add('callback.url', 'must be an absolute URL');
    return;
  }
  if (url.protocol !== 'https:') {
    c.add('callback.url', 'must use https');
  }
  if (url.username || url.password || url.search) {
    c.add('callback.url', 'must not embed credentials or query parameters');
  }
}

function validateSponsorship(c, profile) {
  const sponsorship = c.object(profile.sponsorship, 'sponsorship');
  c.enumValue(sponsorship.signerCustodyMode, CUSTODY_MODES, 'sponsorship.signerCustodyMode');
  validateSecretRef(c, sponsorship.managedSignerSecretRef, 'sponsorship.managedSignerSecretRef');
  c.equal(sponsorship.capacityFailClosed, true, 'sponsorship.capacityFailClosed', 'the pilot');
  const ceilings = c.object(sponsorship.ceilings, 'sponsorship.ceilings');
  c.positiveInteger(ceilings.maxGasLimit, 'sponsorship.ceilings.maxGasLimit');
  const fee = c.pattern(
    ceilings.maxFeePerGasWei,
    DECIMAL_WEI_PATTERN,
    'sponsorship.ceilings.maxFeePerGasWei',
    'a positive canonical decimal string',
  );
  const cost = c.pattern(
    ceilings.maxNativeCostWei,
    DECIMAL_WEI_PATTERN,
    'sponsorship.ceilings.maxNativeCostWei',
    'a positive canonical decimal string',
  );
  if (fee && cost && Number.isSafeInteger(ceilings.maxGasLimit)) {
    if (BigInt(ceilings.maxNativeCostWei) < BigInt(ceilings.maxGasLimit) * BigInt(ceilings.maxFeePerGasWei)) {
      c.add(
        'sponsorship.ceilings.maxNativeCostWei',
        'must cover maxGasLimit multiplied by maxFeePerGasWei',
      );
    }
  }
  const approval = c.object(sponsorship.approval, 'sponsorship.approval');
  c.enumValue(approval.status, APPROVAL_STATUSES, 'sponsorship.approval.status');
  if (typeof approval.authority !== 'string' || approval.authority.trim() === '') {
    c.add('sponsorship.approval.authority', 'must name the approving authority');
  }
  if (approval.status === 'approved') {
    c.pattern(
      approval.evidence,
      DECISION_EVIDENCE_PATTERN,
      'sponsorship.approval.evidence',
      'a link to the recorded approval comment or review',
    );
  }
}

function validateFlagsAndSurfaces(c, profile) {
  const flags = c.object(profile.featureFlags, 'featureFlags');
  c.equal(flags.contractAddressRequired, true, 'featureFlags.contractAddressRequired', 'the pilot');
  c.equal(
    flags.immediateInspectionAcceptance,
    false,
    'featureFlags.immediateInspectionAcceptance',
    'the buyer-signed inspection protocol (#640)',
  );
  c.equal(flags.rateLimitEnabled, true, 'featureFlags.rateLimitEnabled', 'the pilot');
  c.equal(flags.rateLimitFailOpen, false, 'featureFlags.rateLimitFailOpen', 'the pilot');

  if (!Array.isArray(profile.surfaces) || profile.surfaces.length === 0) {
    c.add('surfaces', 'must classify every Cotsel service surface');
    return;
  }
  const seen = new Set();
  profile.surfaces.forEach((surface, index) => {
    const field = `surfaces[${index}]`;
    c.pattern(surface?.service, SERVICE_PATTERN, `${field}.service`, 'a service name');
    c.enumValue(surface?.exposure, EXPOSURES, `${field}.exposure`);
    if (seen.has(surface?.service)) {
      c.add(`${field}.service`, 'must be classified only once');
    }
    seen.add(surface?.service);
    if (surface?.exposure === 'cloudfront-waf') {
      if (surface.service !== 'gateway') {
        c.add(`${field}.exposure`, 'only the gateway may be routed through the public edge');
      }
      c.pattern(surface.pathPrefix, /^\/api\/[a-z0-9/-]+\/$/, `${field}.pathPrefix`, 'an API prefix');
    } else if (surface?.pathPrefix !== undefined) {
      c.add(`${field}.pathPrefix`, 'is allowed only for edge-routed surfaces');
    }
  });
  if (!profile.surfaces.some((surface) => surface?.exposure === 'cloudfront-waf')) {
    c.add('surfaces', 'must declare the single public gateway surface');
  }
}

function validateProbe(c, probe, field, prefix) {
  const value = c.object(probe, field);
  if (!READ_ONLY_METHODS.includes(value.method)) {
    c.add(`${field}.method`, 'must be a read-only HTTP method so the probe has no side effects');
  }
  if (typeof value.path !== 'string' || !prefix || !value.path.startsWith(prefix)) {
    c.add(`${field}.path`, 'must live under the public gateway prefix');
  }
}

function validateReadiness(c, profile) {
  const readiness = c.object(profile.readiness, 'readiness');
  const prefix = profile.surfaces?.find?.((s) => s?.exposure === 'cloudfront-waf')?.pathPrefix;
  validateProbe(c, readiness.endpoint, 'readiness.endpoint', prefix);
  validateProbe(c, readiness.livenessEndpoint, 'readiness.livenessEndpoint', prefix);
  if (readiness.endpoint?.path && readiness.endpoint.path === readiness.livenessEndpoint?.path) {
    c.add('readiness.livenessEndpoint', 'must stay separate from financial readiness');
  }
  c.equal(readiness.sideEffects, 'none', 'readiness.sideEffects', 'SOW 3.4');
  for (const name of ['postgres', 'auth-service', 'chain-rpc', 'indexer-graphql']) {
    if (!readiness.requiredDependencies?.includes?.(name)) {
      c.add('readiness.requiredDependencies', `must include ${name}`);
    }
  }
  for (const name of GASLESS_READINESS) {
    if (!readiness.gaslessDependencies?.includes?.(name)) {
      c.add('readiness.gaslessDependencies', `must include ${name}`);
    }
  }
}

function validateBoundaryLists(c, profile) {
  for (const capability of MANDATORY_UNSUPPORTED) {
    if (!profile.unsupportedCapabilities?.includes?.(capability)) {
      c.add('unsupportedCapabilities', `must explicitly disable ${capability}`);
    }
  }
  if (!Array.isArray(profile.invalidationTriggers) || profile.invalidationTriggers.length === 0) {
    c.add('invalidationTriggers', 'must list the events that invalidate this profile');
  }
}

/**
 * Validates a launch profile against the repository's accepted identities. Pass
 * `requirePromotable` when the profile is about to gate a pilot promotion: only an accepted
 * profile with approved sponsorship limits may pass.
 */
export function validatePilotLaunchProfile(
  profile,
  { stagingContract, releaseManifest, authorityRegistry, rootDir = ROOT_DIR, requirePromotable = false } = {},
) {
  const c = createCollector();
  if (!isPlainObject(profile)) {
    c.add('profile', 'must be a JSON object');
    return { ok: false, errors: c.errors };
  }
  c.equal(profile.schemaVersion, PROFILE_SCHEMA_VERSION, 'schemaVersion', 'this validator');
  c.pattern(profile.profileId, /^[a-z0-9][a-z0-9-]{3,80}$/, 'profileId', 'a stable identifier');
  c.enumValue(profile.environment, ENVIRONMENTS, 'environment');
  c.enumValue(profile.status, PROFILE_STATUSES, 'status');
  validateTraceability(c, profile);
  validateRelease(c, profile, authorityRegistry, rootDir);
  validateNetwork(c, profile, stagingContract);
  validateRpcAndAuth(c, profile);
  validateCallback(c, profile, releaseManifest);
  validateSponsorship(c, profile);
  validateFlagsAndSurfaces(c, profile);
  validateReadiness(c, profile);
  validateBoundaryLists(c, profile);
  validateAcceptance(c, profile, authorityRegistry);

  if (profile.status === 'withdrawn') {
    c.add('status', 'a withdrawn profile cannot gate a launch');
  }
  if (requirePromotable) {
    if (profile.status !== 'accepted') {
      c.add('status', 'must be accepted by the independent acceptance owner before promotion');
    }
    if (profile.sponsorship?.approval?.status !== 'approved') {
      c.add('sponsorship.approval.status', 'must be approved under WP-0 before promotion');
    }
  }
  return { ok: c.errors.length === 0, errors: c.errors };
}

/** Loads a profile and the repository identities it must agree with. */
export function loadPilotLaunchInputs(profilePath = DEFAULT_PROFILE_PATH, rootDir = ROOT_DIR) {
  const profile = readRepositoryJson(profilePath, rootDir);
  let stagingContract;
  const identityPath = profile?.network?.contractIdentity;
  if (typeof identityPath === 'string' && REPO_PATH_PATTERN.test(identityPath)) {
    try {
      stagingContract = readRepositoryJson(identityPath, rootDir);
    } catch {
      stagingContract = undefined;
    }
  }
  return {
    profile,
    stagingContract,
    releaseManifest: readRepositoryJson('integration/release-manifest.json', rootDir),
    authorityRegistry: readRepositoryJson('integration/release-authority-profile.json', rootDir),
  };
}
