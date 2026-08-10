#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');

const CANDIDATE_ID_PATTERN = /^cotsel-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]{4,16}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ISSUE_PATTERN = /^https:\/\/github\.com\/Agroasys\/[A-Za-z0-9._-]+\/issues\/[0-9]+$/;
const CONTROL_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,23}$/;
const ROUTE_PATTERN = /^wp[0-9]{1,2}-[a-z0-9-]+$/;
/**
 * Every actor identity — approver, producer, reviewer, equivalence acceptor — is written in one
 * canonical handle form: lowercase, no whitespace, 2 to 64 characters. The two-person control is
 * enforced with string equality on these fields, so `avitus`, `AvitusI` and `Avitus I` must not be
 * able to name the same person three ways.
 */
const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._@/+-]{1,63}$/;

const MANIFEST_STATUSES = ['draft', 'candidate', 'promoted', 'superseded'];
const ENVIRONMENTS = ['local-ci', 'base-sepolia-staging', 'base-mainnet'];
const CLASSIFICATIONS = ['non-deployed', 'private-staging', 'controlled-pilot', 'production'];
const ARTIFACT_KINDS = ['container-image', 'npm-package', 'contract-bundle'];
const PROVIDER_MODES = {
  fiatOffRamp: ['disabled', 'sandbox', 'live'],
  signer: ['local-key', 'kms', 'mpc'],
  rpc: ['single', 'primary-with-fallback'],
};
const ACCEPTANCE_ROLES = ['Release Owner', 'Security reviewer', 'Operations reviewer'];
const REVIEW_DECISIONS = ['accepted', 'rejected', 'pending'];
const AUTHORITY_PROFILE_PATH = path.join(ROOT_DIR, 'integration/release-authority-profile.json');

const INTERNAL_BASE_SEPOLIA_AUTHORITY_PROFILE = JSON.parse(
  fs.readFileSync(AUTHORITY_PROFILE_PATH, 'utf8'),
);

function validateAuthorityProfile(profile) {
  if (!isPlainObject(profile)) {
    throw new Error('Release authority profile must be an object');
  }
  if (profile.schemaVersion !== 'cotsel.release-authority-profile.v1') {
    throw new Error('Release authority profile has an unsupported schemaVersion');
  }
  if (profile.environment !== 'base-sepolia-staging') {
    throw new Error('Release authority profile must bind base-sepolia-staging');
  }
  for (const role of ACCEPTANCE_ROLES) {
    requireString(
      (message) => {
        throw new Error(`Release authority profile ${message}`);
      },
      profile.approvalRoles?.[role],
      `approvalRoles.${role}`,
      IDENTITY_PATTERN,
    );
  }
  const namedIdentities = new Set(Object.values(profile.approvalRoles));
  if (namedIdentities.size !== 2) {
    throw new Error('Release authority profile must name exactly two approval identities');
  }
  for (const identity of namedIdentities) {
    const reviewer = profile.evidenceReviewers?.[identity];
    requireString(
      (message) => {
        throw new Error(`Release authority profile ${message}`);
      },
      reviewer,
      `evidenceReviewers.${identity}`,
      IDENTITY_PATTERN,
    );
    if (reviewer === identity || !namedIdentities.has(reviewer)) {
      throw new Error(
        `Release authority profile reviewer for ${identity} must be the other named identity`,
      );
    }
  }
  if (
    !Array.isArray(profile.automatedEvidenceProducers) ||
    profile.automatedEvidenceProducers.some((identity) => !IDENTITY_PATTERN.test(identity))
  ) {
    throw new Error(
      'Release authority profile automatedEvidenceProducers must be canonical handles',
    );
  }
}

validateAuthorityProfile(INTERNAL_BASE_SEPOLIA_AUTHORITY_PROFILE);

function authorityProfileForManifest(manifest) {
  return manifest.environment?.name === INTERNAL_BASE_SEPOLIA_AUTHORITY_PROFILE.environment
    ? INTERNAL_BASE_SEPOLIA_AUTHORITY_PROFILE
    : null;
}

function requireProfileRoleIdentity(fail, profile, role, identity, label) {
  const expectedIdentity = profile.approvalRoles[role];
  if (identity !== expectedIdentity) {
    fail(`${label} must be ${expectedIdentity} under ${profile.profileId}`);
  }
}

function requireRecusedEvidenceReviewer(fail, profile, producerIdentity, reviewerIdentity, label) {
  const requiredReviewer = profile.evidenceReviewers[producerIdentity];
  if (requiredReviewer && reviewerIdentity !== requiredReviewer) {
    fail(`${label} produced by ${producerIdentity} must be reviewed by ${requiredReviewer}`);
  }
}

function requireAuthorizedEvidenceProducer(fail, profile, identity, label) {
  const isNamedParticipant = Object.hasOwn(profile.evidenceReviewers, identity);
  const isApprovedAutomation = profile.automatedEvidenceProducers.includes(identity);
  if (!isNamedParticipant && !isApprovedAutomation) {
    fail(`${label} producer ${identity} is not authorized under ${profile.profileId}`);
  }
}

/**
 * Environment classifications each environment may declare. ENV-01 through ENV-04 keep local,
 * private staging, controlled pilot and production boundaries distinct.
 */
const ALLOWED_CLASSIFICATIONS = new Map([
  ['local-ci', ['non-deployed']],
  ['base-sepolia-staging', ['private-staging', 'controlled-pilot']],
  ['base-mainnet', ['production']],
]);

const BASE_MAINNET_CHAIN_ID = 8453;

/**
 * The identity dimensions REPORT-02 and PROG-01 name. Evidence may not be reused across any of
 * them without an accepted equivalence.
 *
 * `contractDeployedBytecodeSha256` is a dimension in its own right because a contract address is
 * not an implementation: a proxy upgrade keeps the address, and the same source under a different
 * compiler or optimizer setting keeps both the address and the commit. Any ABI difference that
 * changes behaviour changes the deployed bytecode with it, so the bytecode digest also covers
 * `contractAbiSha256`; an ABI difference that leaves the bytecode identical is metadata only and
 * cannot change what a run proves.
 */
export const IDENTITY_DIMENSIONS = [
  'sourceCommit',
  'artifactDigests',
  'environment',
  'chainId',
  'contractAddress',
  'contractDeployedBytecodeSha256',
  'migrationIdentities',
  'providerMode',
  'configDigestSha256',
];

function failManifest(message) {
  throw new Error(`Candidate manifest invalid: ${message}`);
}

function failIndex(message) {
  throw new Error(`Evidence index invalid: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(fail, value, name, pattern) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} is required`);
  }
  if (pattern && !pattern.test(value)) {
    fail(`${name} does not match ${pattern}`);
  }
  return value;
}

function requireEnum(fail, value, name, allowed) {
  if (!allowed.includes(value)) {
    fail(`${name} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

function requireInteger(fail, value, name, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

function requireTimestamp(fail, value, name) {
  requireString(fail, value, name);
  if (Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 timestamp`);
  }
  return value;
}

/**
 * Deterministic serialization. Two documents with the same content produce the same digest
 * regardless of key order, so an identity digest cannot drift on reserialization.
 */
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

function normalizeProviderMode(providerMode) {
  return {
    fiatOffRamp: providerMode.fiatOffRamp,
    signer: providerMode.signer,
    rpc: providerMode.rpc,
  };
}

/**
 * The immutable identity of a candidate. Lifecycle fields (status, approvals, rollback notes)
 * are deliberately excluded: promoting a candidate must not invalidate evidence already bound
 * to it, but changing any identity dimension must.
 */
export function candidateIdentity(manifest) {
  return {
    candidateId: manifest.candidateId,
    sourceCommit: manifest.source.commit,
    crossRepositoryManifestSha256: manifest.crossRepositoryManifest.sha256,
    artifactDigests: manifest.artifacts.map((artifact) => artifact.digest).sort(),
    environment: manifest.environment.name,
    chainId: manifest.chain.chainId,
    contractAddress: manifest.contract.address.toLowerCase(),
    contractAbiSha256: manifest.contract.abiSha256,
    contractDeployedBytecodeSha256: manifest.contract.deployedBytecodeSha256,
    migrationIdentities: manifest.migrations
      .map((migration) => `${migration.component}@${migration.headIdentity}`)
      .sort(),
    providerMode: normalizeProviderMode(manifest.providerMode),
    configDigestSha256: manifest.configDigest.sha256,
  };
}

export function candidateIdentityDigest(manifest) {
  return canonicalDigest(candidateIdentity(manifest));
}

function validateEnvironment(environment) {
  if (!isPlainObject(environment)) {
    failManifest('environment is required');
  }
  requireEnum(failManifest, environment.name, 'environment.name', ENVIRONMENTS);
  requireEnum(
    failManifest,
    environment.classification,
    'environment.classification',
    CLASSIFICATIONS,
  );
  requireString(failManifest, environment.owner, 'environment.owner');

  const allowed = ALLOWED_CLASSIFICATIONS.get(environment.name);
  if (!allowed.includes(environment.classification)) {
    failManifest(
      `environment ${environment.name} cannot be classified ${environment.classification}`,
    );
  }
  if (typeof environment.publicParticipants !== 'boolean') {
    failManifest('environment.publicParticipants must be declared');
  }
  if (typeof environment.realCommercialValue !== 'boolean') {
    failManifest('environment.realCommercialValue must be declared');
  }
  if (environment.name !== 'base-mainnet') {
    // ENV-01 and ENV-02 prohibit public users and real commercial value outside production.
    if (environment.publicParticipants) {
      failManifest(`environment ${environment.name} cannot admit public participants`);
    }
    if (environment.realCommercialValue) {
      failManifest(`environment ${environment.name} cannot carry real commercial value`);
    }
  }
}

function validateContract(contract) {
  if (!isPlainObject(contract)) {
    failManifest('contract is required');
  }
  if (contract.name !== 'AgroasysEscrow') {
    failManifest('contract.name must be AgroasysEscrow');
  }
  requireString(failManifest, contract.address, 'contract.address', ADDRESS_PATTERN);
  requireString(failManifest, contract.abiSha256, 'contract.abiSha256', SHA256_PATTERN);
  requireString(
    failManifest,
    contract.deployedBytecodeSha256,
    'contract.deployedBytecodeSha256',
    SHA256_PATTERN,
  );
  requireString(failManifest, contract.compilerVersion, 'contract.compilerVersion');
  requireInteger(failManifest, contract.deploymentBlock, 'contract.deploymentBlock', 0);
  requireString(
    failManifest,
    contract.deploymentTxHash,
    'contract.deploymentTxHash',
    TX_HASH_PATTERN,
  );
  requireEnum(failManifest, contract.verificationStatus, 'contract.verificationStatus', [
    'verified',
    'unverified',
  ]);
}

function validateProviderMode(providerMode, fail, name) {
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

export function validateCandidateManifest(manifest) {
  if (!isPlainObject(manifest)) {
    failManifest('root must be an object');
  }
  if (manifest.schemaVersion !== 'cotsel.candidate-manifest.v1') {
    failManifest('schemaVersion must be cotsel.candidate-manifest.v1');
  }
  requireString(failManifest, manifest.candidateId, 'candidateId', CANDIDATE_ID_PATTERN);
  requireEnum(failManifest, manifest.status, 'status', MANIFEST_STATUSES);
  if (manifest.owner?.role !== 'Release Owner') {
    failManifest('the single accountable owner must be Release Owner');
  }
  requireTimestamp(failManifest, manifest.createdAt, 'createdAt');
  if (manifest.supersedes !== undefined) {
    requireString(failManifest, manifest.supersedes, 'supersedes', CANDIDATE_ID_PATTERN);
    if (manifest.supersedes === manifest.candidateId) {
      failManifest('a candidate cannot supersede itself');
    }
  }

  if (manifest.status === 'draft') {
    if (
      !Array.isArray(manifest.activationBlockers) ||
      manifest.activationBlockers.length === 0 ||
      manifest.activationBlockers.some(
        (blocker) => typeof blocker !== 'string' || blocker.trim().length === 0,
      )
    ) {
      failManifest('draft status requires at least one activation blocker');
    }
  }

  validateEnvironment(manifest.environment);

  if (!isPlainObject(manifest.source)) {
    failManifest('source is required');
  }
  if (manifest.source.repository !== 'Agroasys/Cotsel') {
    failManifest('source.repository must be Agroasys/Cotsel');
  }
  requireString(failManifest, manifest.source.commit, 'source.commit', COMMIT_PATTERN);
  requireString(failManifest, manifest.source.workflowRunId, 'source.workflowRunId');

  if (!isPlainObject(manifest.crossRepositoryManifest)) {
    failManifest('crossRepositoryManifest is required');
  }
  if (manifest.crossRepositoryManifest.path !== 'integration/release-manifest.json') {
    failManifest('crossRepositoryManifest.path must be integration/release-manifest.json');
  }
  if (manifest.crossRepositoryManifest.schemaVersion !== 'cotsel.release-manifest.v1') {
    failManifest('crossRepositoryManifest.schemaVersion must be cotsel.release-manifest.v1');
  }
  requireString(
    failManifest,
    manifest.crossRepositoryManifest.sha256,
    'crossRepositoryManifest.sha256',
    SHA256_PATTERN,
  );

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    failManifest('at least one artifact must be pinned');
  }
  const artifactNames = new Set();
  for (const artifact of manifest.artifacts) {
    requireString(failManifest, artifact?.name, 'artifact.name');
    if (artifactNames.has(artifact.name)) {
      failManifest(`duplicate artifact ${artifact.name}`);
    }
    artifactNames.add(artifact.name);
    requireEnum(failManifest, artifact.kind, `artifact ${artifact.name} kind`, ARTIFACT_KINDS);
    requireString(
      failManifest,
      artifact.digest,
      `artifact ${artifact.name} digest`,
      DIGEST_PATTERN,
    );
  }

  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    failManifest('at least one migration identity must be pinned');
  }
  const migrationComponents = new Set();
  for (const migration of manifest.migrations) {
    requireString(failManifest, migration?.component, 'migration.component');
    if (migrationComponents.has(migration.component)) {
      failManifest(`duplicate migration component ${migration.component}`);
    }
    migrationComponents.add(migration.component);
    requireString(
      failManifest,
      migration.headIdentity,
      `migration ${migration.component} headIdentity`,
    );
    requireString(
      failManifest,
      migration.checksumSha256,
      `migration ${migration.component} checksumSha256`,
      SHA256_PATTERN,
    );
  }

  if (!isPlainObject(manifest.chain)) {
    failManifest('chain is required');
  }
  requireString(failManifest, manifest.chain.name, 'chain.name');
  requireInteger(failManifest, manifest.chain.chainId, 'chain.chainId', 1);
  requireInteger(
    failManifest,
    manifest.chain.finalityConfirmations,
    'chain.finalityConfirmations',
    1,
  );
  if (
    (manifest.chain.chainId === BASE_MAINNET_CHAIN_ID) !==
    (manifest.environment.name === 'base-mainnet')
  ) {
    // ASSUMPTION-03 keeps rehearsal and mainnet identities distinct in both directions.
    failManifest('chain.chainId and environment.name disagree about Base mainnet');
  }

  validateContract(manifest.contract);
  validateProviderMode(manifest.providerMode, failManifest, 'providerMode');

  if (!isPlainObject(manifest.configDigest)) {
    failManifest('configDigest is required');
  }
  if (manifest.configDigest.redacted !== true) {
    failManifest('configDigest.redacted must be true; raw configuration is never indexed');
  }
  requireString(failManifest, manifest.configDigest.sha256, 'configDigest.sha256', SHA256_PATTERN);
  requireString(failManifest, manifest.configDigest.inventoryPath, 'configDigest.inventoryPath');

  if (!isPlainObject(manifest.rollbackTarget)) {
    failManifest('rollbackTarget is required');
  }
  requireEnum(failManifest, manifest.rollbackTarget.kind, 'rollbackTarget.kind', [
    'candidate',
    'none',
  ]);
  requireString(
    failManifest,
    manifest.rollbackTarget.compatibilityNote,
    'rollbackTarget.compatibilityNote',
  );
  if (manifest.rollbackTarget.kind === 'candidate') {
    requireString(
      failManifest,
      manifest.rollbackTarget.candidateId,
      'rollbackTarget.candidateId',
      CANDIDATE_ID_PATTERN,
    );
    if (manifest.rollbackTarget.candidateId === manifest.candidateId) {
      failManifest('a candidate cannot be its own rollback target');
    }
  }

  if (manifest.approvals !== undefined) {
    if (!Array.isArray(manifest.approvals)) {
      failManifest('approvals must be an array');
    }
    const approvalRoles = new Set();
    for (const approval of manifest.approvals) {
      requireEnum(failManifest, approval?.role, 'approval.role', ACCEPTANCE_ROLES);
      if (approvalRoles.has(approval.role)) {
        failManifest(`duplicate approval for ${approval.role}`);
      }
      approvalRoles.add(approval.role);
      requireString(
        failManifest,
        approval.identity,
        `approval ${approval.role} identity`,
        IDENTITY_PATTERN,
      );
      requireEnum(failManifest, approval.decision, `approval ${approval.role} decision`, [
        'approved',
        'rejected',
      ]);
      requireTimestamp(failManifest, approval.decidedAt, `approval ${approval.role} decidedAt`);
    }
  }

  if (manifest.status === 'promoted') {
    const approved = new Set(
      (manifest.approvals ?? [])
        .filter((approval) => approval.decision === 'approved')
        .map((approval) => approval.role),
    );
    const missing = ACCEPTANCE_ROLES.filter((role) => !approved.has(role));
    if (missing.length > 0) {
      failManifest(`promoted status requires approval from ${missing.join(', ')}`);
    }
    const approvingIdentities = new Set(
      (manifest.approvals ?? [])
        .filter((approval) => approval.decision === 'approved')
        .map((approval) => approval.identity),
    );
    if (approvingIdentities.size < 2) {
      failManifest('promoted status requires approval from two distinct identities');
    }
  }

  const authorityProfile = authorityProfileForManifest(manifest);
  if (authorityProfile && manifest.approvals !== undefined) {
    for (const approval of manifest.approvals) {
      requireProfileRoleIdentity(
        failManifest,
        authorityProfile,
        approval.role,
        approval.identity,
        `approval ${approval.role} identity`,
      );
    }
  }

  return manifest;
}

/**
 * Only a candidate or promoted manifest may receive evidence. A draft is not an identity yet and
 * a superseded candidate can no longer accrue proof.
 */
export function assertCandidateBindable(manifest) {
  if (!['candidate', 'promoted'].includes(manifest.status)) {
    failManifest(`status ${manifest.status} cannot bind evidence`);
  }
  return manifest;
}

function entryIdentity(boundIdentity) {
  return {
    sourceCommit: boundIdentity.sourceCommit,
    artifactDigests: [...boundIdentity.artifactDigests].sort(),
    environment: boundIdentity.environment,
    chainId: boundIdentity.chainId,
    contractAddress: boundIdentity.contractAddress.toLowerCase(),
    contractDeployedBytecodeSha256: boundIdentity.contractDeployedBytecodeSha256,
    migrationIdentities: [...boundIdentity.migrationIdentities].sort(),
    providerMode: normalizeProviderMode(boundIdentity.providerMode),
    configDigestSha256: boundIdentity.configDigestSha256,
  };
}

function validateBoundIdentity(boundIdentity, label) {
  if (!isPlainObject(boundIdentity)) {
    failIndex(`${label} boundIdentity is required`);
  }
  requireString(failIndex, boundIdentity.sourceCommit, `${label} sourceCommit`, COMMIT_PATTERN);
  if (!Array.isArray(boundIdentity.artifactDigests) || boundIdentity.artifactDigests.length === 0) {
    failIndex(`${label} artifactDigests is required`);
  }
  for (const digest of boundIdentity.artifactDigests) {
    requireString(failIndex, digest, `${label} artifact digest`, DIGEST_PATTERN);
  }
  requireEnum(failIndex, boundIdentity.environment, `${label} environment`, ENVIRONMENTS);
  requireInteger(failIndex, boundIdentity.chainId, `${label} chainId`, 1);
  requireString(
    failIndex,
    boundIdentity.contractAddress,
    `${label} contractAddress`,
    ADDRESS_PATTERN,
  );
  requireString(
    failIndex,
    boundIdentity.contractDeployedBytecodeSha256,
    `${label} contractDeployedBytecodeSha256`,
    SHA256_PATTERN,
  );
  if (
    !Array.isArray(boundIdentity.migrationIdentities) ||
    boundIdentity.migrationIdentities.length === 0
  ) {
    failIndex(`${label} migrationIdentities is required`);
  }
  for (const identity of boundIdentity.migrationIdentities) {
    requireString(failIndex, identity, `${label} migration identity`);
  }
  validateProviderMode(boundIdentity.providerMode, failIndex, `${label} providerMode`);
  requireString(
    failIndex,
    boundIdentity.configDigestSha256,
    `${label} configDigestSha256`,
    SHA256_PATTERN,
  );
}

/**
 * An equivalence is a waiver of the binding rule, so the producer of the evidence may not certify
 * that their own stale evidence still counts. A reviewer may accept an equivalence for evidence
 * someone else produced — the same two-person control applies.
 */
function validateEquivalence(equivalence, entry, label, now, authorityProfile) {
  requireString(
    failIndex,
    equivalence.acceptedBy,
    `${label} equivalence acceptedBy`,
    IDENTITY_PATTERN,
  );
  if (equivalence.acceptedBy === entry.producedBy.identity) {
    failIndex(
      `${label} equivalence was accepted by its own producer; review by the other participant is required`,
    );
  }
  requireEnum(failIndex, equivalence.role, `${label} equivalence role`, ACCEPTANCE_ROLES);
  if (authorityProfile) {
    requireProfileRoleIdentity(
      failIndex,
      authorityProfile,
      equivalence.role,
      equivalence.acceptedBy,
      `${label} equivalence acceptedBy`,
    );
  }
  requireString(failIndex, equivalence.rationale, `${label} equivalence rationale`);
  requireTimestamp(failIndex, equivalence.expiresAt, `${label} equivalence expiresAt`);
  if (!Array.isArray(equivalence.dimensions) || equivalence.dimensions.length === 0) {
    failIndex(`${label} equivalence must name at least one dimension`);
  }
  for (const dimension of equivalence.dimensions) {
    requireEnum(failIndex, dimension, `${label} equivalence dimension`, IDENTITY_DIMENSIONS);
  }
  if (Date.parse(equivalence.expiresAt) <= now.getTime()) {
    failIndex(`${label} equivalence expired at ${equivalence.expiresAt}`);
  }
  return new Set(equivalence.dimensions);
}

/**
 * Binds an evidence index to exactly one candidate manifest. Every entry must have been produced
 * against the same identity, on every dimension REPORT-02 and PROG-01 name, unless an unexpired
 * equivalence accepted by a named authority covers that dimension.
 */
export function validateEvidenceIndex(index, manifest, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  validateCandidateManifest(manifest);
  assertCandidateBindable(manifest);
  const authorityProfile = authorityProfileForManifest(manifest);

  if (!isPlainObject(index)) {
    failIndex('root must be an object');
  }
  if (index.schemaVersion !== 'cotsel.evidence-index.v1') {
    failIndex('schemaVersion must be cotsel.evidence-index.v1');
  }
  requireString(failIndex, index.candidateId, 'candidateId', CANDIDATE_ID_PATTERN);
  if (index.candidateId !== manifest.candidateId) {
    failIndex(`candidateId ${index.candidateId} does not match manifest ${manifest.candidateId}`);
  }
  requireTimestamp(failIndex, index.generatedAt, 'generatedAt');

  const expectedDigest = candidateIdentityDigest(manifest);
  if (!isPlainObject(index.manifest)) {
    failIndex('manifest reference is required');
  }
  requireString(failIndex, index.manifest.path, 'manifest.path');
  requireString(failIndex, index.manifest.sha256, 'manifest.sha256', SHA256_PATTERN);
  if (index.manifest.sha256 !== expectedDigest) {
    failIndex(
      `manifest.sha256 ${index.manifest.sha256} does not resolve to the promoted candidate identity ${expectedDigest}`,
    );
  }

  // PROG-01: the environment report carries the manifest identity and the redacted config digest.
  if (!isPlainObject(index.environmentReport)) {
    failIndex('environmentReport is required');
  }
  requireString(failIndex, index.environmentReport.path, 'environmentReport.path');
  requireString(
    failIndex,
    index.environmentReport.sha256,
    'environmentReport.sha256',
    SHA256_PATTERN,
  );
  requireString(
    failIndex,
    index.environmentReport.manifestSha256,
    'environmentReport.manifestSha256',
    SHA256_PATTERN,
  );
  requireString(
    failIndex,
    index.environmentReport.configDigestSha256,
    'environmentReport.configDigestSha256',
    SHA256_PATTERN,
  );
  if (index.environmentReport.manifestSha256 !== expectedDigest) {
    failIndex('environmentReport is bound to a different candidate identity');
  }
  if (index.environmentReport.configDigestSha256 !== manifest.configDigest.sha256) {
    failIndex('environmentReport configuration digest does not match the candidate manifest');
  }

  if (!Array.isArray(index.entries) || index.entries.length === 0) {
    failIndex('at least one evidence entry is required');
  }

  const expected = candidateIdentity(manifest);
  const seenArtifacts = new Set();

  for (const [position, entry] of index.entries.entries()) {
    const label = `entry ${position} (${entry?.controlId ?? '<missing control>'})`;
    if (!isPlainObject(entry)) {
      failIndex(`${label} must be an object`);
    }
    requireString(failIndex, entry.controlId, `${label} controlId`, CONTROL_ID_PATTERN);
    requireString(failIndex, entry.route, `${label} route`, ROUTE_PATTERN);
    requireString(failIndex, entry.issue, `${label} issue`, ISSUE_PATTERN);

    if (!isPlainObject(entry.artifact)) {
      failIndex(`${label} artifact is required`);
    }
    requireString(failIndex, entry.artifact.uri, `${label} artifact uri`);
    requireString(failIndex, entry.artifact.sha256, `${label} artifact sha256`, SHA256_PATTERN);
    requireString(failIndex, entry.artifact.runId, `${label} artifact runId`);

    const artifactKey = `${entry.controlId}:${entry.artifact.sha256}`;
    if (seenArtifacts.has(artifactKey)) {
      failIndex(`${label} duplicates an artifact already indexed for ${entry.controlId}`);
    }
    seenArtifacts.add(artifactKey);

    if (!isPlainObject(entry.producedBy)) {
      failIndex(`${label} producedBy is required`);
    }
    requireString(
      failIndex,
      entry.producedBy.identity,
      `${label} producedBy identity`,
      IDENTITY_PATTERN,
    );
    requireString(failIndex, entry.producedBy.role, `${label} producedBy role`);

    if (!isPlainObject(entry.reviewer)) {
      failIndex(`${label} reviewer is required`);
    }
    requireString(
      failIndex,
      entry.reviewer.identity,
      `${label} reviewer identity`,
      IDENTITY_PATTERN,
    );
    requireEnum(failIndex, entry.reviewer.role, `${label} reviewer role`, ACCEPTANCE_ROLES);
    requireEnum(failIndex, entry.reviewer.decision, `${label} reviewer decision`, REVIEW_DECISIONS);
    requireTimestamp(failIndex, entry.reviewer.reviewedAt, `${label} reviewer reviewedAt`);
    if (entry.reviewer.identity === entry.producedBy.identity) {
      failIndex(
        `${label} was accepted by its own producer; review by the other participant is required`,
      );
    }
    if (authorityProfile) {
      requireAuthorizedEvidenceProducer(
        failIndex,
        authorityProfile,
        entry.producedBy.identity,
        `${label} evidence`,
      );
      requireProfileRoleIdentity(
        failIndex,
        authorityProfile,
        entry.reviewer.role,
        entry.reviewer.identity,
        `${label} reviewer identity`,
      );
      requireRecusedEvidenceReviewer(
        failIndex,
        authorityProfile,
        entry.producedBy.identity,
        entry.reviewer.identity,
        `${label} evidence`,
      );
    }

    validateBoundIdentity(entry.boundIdentity, label);
    const actual = entryIdentity(entry.boundIdentity);

    let accepted = new Set();
    if (entry.equivalence !== undefined) {
      if (!isPlainObject(entry.equivalence)) {
        failIndex(`${label} equivalence must be an object`);
      }
      accepted = validateEquivalence(entry.equivalence, entry, label, now, authorityProfile);
    }

    for (const dimension of IDENTITY_DIMENSIONS) {
      const expectedValue = canonicalize(expected[dimension]);
      const actualValue = canonicalize(actual[dimension]);
      if (expectedValue === actualValue) {
        continue;
      }
      if (!accepted.has(dimension)) {
        failIndex(
          `${label} was produced against a different ${dimension} (${actualValue}) than the candidate manifest (${expectedValue}); stale evidence cannot be reused without an accepted equivalence`,
        );
      }
      if (
        (dimension === 'chainId' &&
          (actual.chainId === BASE_MAINNET_CHAIN_ID ||
            expected.chainId === BASE_MAINNET_CHAIN_ID)) ||
        (dimension === 'environment' &&
          (actual.environment === 'base-mainnet' || expected.environment === 'base-mainnet'))
      ) {
        // ASSUMPTION-03 and ENV-04: mainnet readiness is never inherited from a rehearsal run.
        failIndex(
          `${label} claims equivalence across the Base mainnet boundary, which is not waivable`,
        );
      }
    }

    for (const dimension of accepted) {
      if (canonicalize(expected[dimension]) === canonicalize(actual[dimension])) {
        failIndex(`${label} accepts equivalence for ${dimension}, which does not differ`);
      }
    }
  }

  return index;
}

/**
 * The candidate inherits the sibling-repository pins by digest. A pin change in
 * integration/release-manifest.json therefore produces a different candidate identity.
 */
export function assertCrossRepositoryManifestBinding(manifest, releaseManifestPath) {
  const actual = canonicalDigest(readJsonDocument(releaseManifestPath));
  if (manifest.crossRepositoryManifest.sha256 !== actual) {
    failManifest(
      `crossRepositoryManifest.sha256 ${manifest.crossRepositoryManifest.sha256} does not match ${releaseManifestPath} (${actual})`,
    );
  }
  return manifest;
}

/**
 * Delivery completion is not acceptance. An index is complete only when every required control
 * carries at least one entry a named authority accepted.
 */
export function assertEvidenceIndexComplete(index, requiredControlIds) {
  const acceptedControls = new Set(
    index.entries
      .filter((entry) => entry.reviewer.decision === 'accepted')
      .map((entry) => entry.controlId),
  );
  const missing = requiredControlIds.filter((controlId) => !acceptedControls.has(controlId));
  if (missing.length > 0) {
    failIndex(`no accepted evidence for ${missing.join(', ')}`);
  }
  return index;
}

export function readJsonDocument(documentPath) {
  return JSON.parse(fs.readFileSync(documentPath, 'utf8'));
}

export function readCandidateManifest(manifestPath) {
  return validateCandidateManifest(readJsonDocument(manifestPath));
}

function readFlag(args, name) {
  const position = args.indexOf(name);
  if (position < 0) {
    return undefined;
  }
  const value = args[position + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a path`);
  }
  return path.resolve(ROOT_DIR, value);
}

function readControlListFlag(args, name) {
  const position = args.indexOf(name);
  if (position < 0) {
    return undefined;
  }
  const value = args[position + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a comma-separated list of control identities`);
  }
  const controlIds = value.split(',').map((controlId) => controlId.trim());
  for (const controlId of controlIds) {
    if (!CONTROL_ID_PATTERN.test(controlId)) {
      throw new Error(`${name} value ${controlId} is not a control identity`);
    }
  }
  return controlIds;
}

function main() {
  const args = process.argv.slice(2);
  const manifestPath = readFlag(args, '--manifest');
  const indexPath = readFlag(args, '--index');
  const requiredControlIds = readControlListFlag(args, '--require-controls');

  if (!manifestPath) {
    throw new Error(
      'usage: check-release-evidence-binding.mjs --manifest <candidate-manifest.json> [--index <evidence-index.json>] [--require-controls <CONTROL,CONTROL>]',
    );
  }
  if (requiredControlIds && !indexPath) {
    throw new Error('--require-controls also requires --index');
  }

  const manifest = readCandidateManifest(manifestPath);
  if (args.includes('--verify-cross-repository')) {
    assertCrossRepositoryManifestBinding(
      manifest,
      path.join(ROOT_DIR, 'integration/release-manifest.json'),
    );
  }
  process.stdout.write(
    `Candidate manifest valid (${manifest.status}); candidate=${manifest.candidateId} identity=${candidateIdentityDigest(manifest)}\n`,
  );

  if (indexPath) {
    const index = validateEvidenceIndex(readJsonDocument(indexPath), manifest);
    // Delivery completion is not acceptance: report accepted entries, not merely bound ones, and
    // fail before printing anything when a required control has no accepted evidence.
    if (requiredControlIds) {
      assertEvidenceIndexComplete(index, requiredControlIds);
    }
    const acceptedCount = index.entries.filter(
      (entry) => entry.reviewer.decision === 'accepted',
    ).length;
    process.stdout.write(
      `Evidence index valid; ${index.entries.length} entries bound to ${index.candidateId}, ${acceptedCount} accepted\n`,
    );
    if (requiredControlIds) {
      process.stdout.write(`Accepted evidence present for ${requiredControlIds.join(', ')}\n`);
    } else {
      process.stdout.write(
        'Binding checked, acceptance not checked; pass --require-controls to require accepted evidence\n',
      );
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
