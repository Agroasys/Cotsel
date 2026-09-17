import {
  artifactIdentityDigests,
  assertCrossRepositoryManifestBinding,
  migrationIdentityStrings,
  validateCandidateInventory,
} from './release-candidate-inventory.mjs';
import {
  ACCEPTANCE_ROLES,
  ADDRESS_PATTERN,
  BASE_MAINNET_CHAIN_ID,
  CANDIDATE_ID_PATTERN,
  COMMIT_PATTERN,
  DIGEST_PATTERN,
  ENVIRONMENTS,
  IDENTITY_PATTERN,
  SHA256_PATTERN,
  TX_HASH_PATTERN,
  canonicalDigest,
  failManifest,
  isPlainObject,
  normalizeProviderMode,
  requireEnum,
  requireInteger,
  requireString,
  requireTimestamp,
  validateProviderMode,
} from './release-evidence-validation.mjs';
import {
  assertEvidenceBindingAllowed,
  assertPromotionAllowed,
  authorityProfileForManifest,
  requireProfileRoleIdentity,
} from './release-authority-profile.mjs';

const MANIFEST_STATUSES = ['draft', 'candidate', 'promoted', 'superseded'];
const CLASSIFICATIONS = ['non-deployed', 'private-staging', 'controlled-pilot', 'production'];
const LEGACY_ARTIFACT_KINDS = ['container-image', 'npm-package', 'contract-bundle'];
const ALLOWED_CLASSIFICATIONS = new Map([
  ['local-ci', ['non-deployed']],
  ['base-sepolia-staging', ['private-staging', 'controlled-pilot']],
  ['base-mainnet', ['production']],
]);

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

export function candidateIdentity(manifest) {
  const hasCompleteInventory = manifest.schemaVersion === 'cotsel.candidate-manifest.v2';
  return {
    candidateId: manifest.candidateId,
    sourceCommit: manifest.source.commit,
    crossRepositoryManifestSha256: manifest.crossRepositoryManifest.sha256,
    artifactDigests: hasCompleteInventory
      ? artifactIdentityDigests(manifest)
      : manifest.artifacts.map((artifact) => artifact.digest).sort(),
    environment: manifest.environment.name,
    chainId: manifest.chain.chainId,
    contractAddress: manifest.contract.address.toLowerCase(),
    contractAbiSha256: manifest.contract.abiSha256,
    contractDeployedBytecodeSha256: manifest.contract.deployedBytecodeSha256,
    migrationIdentities: hasCompleteInventory
      ? migrationIdentityStrings(manifest)
      : manifest.migrations
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

function validateLegacyInventory(manifest) {
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
    requireEnum(
      failManifest,
      artifact.kind,
      `artifact ${artifact.name} kind`,
      LEGACY_ARTIFACT_KINDS,
    );
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
}

function validateApprovals(manifest) {
  if (manifest.approvals === undefined) {
    return;
  }
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

function validatePromotion(manifest) {
  const authorityProfile = authorityProfileForManifest(manifest);
  if (manifest.status === 'promoted') {
    assertPromotionAllowed(failManifest, authorityProfile);
    const approvedRoles = new Set(
      (manifest.approvals ?? [])
        .filter((approval) => approval.decision === 'approved')
        .map((approval) => approval.role),
    );
    const missing = ACCEPTANCE_ROLES.filter((role) => !approvedRoles.has(role));
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

  if (authorityProfile.promotionPolicy === 'blocked' && manifest.approvals !== undefined) {
    failManifest(
      `approval records for ${authorityProfile.environment} are blocked: ${authorityProfile.promotionBlocker}`,
    );
  }
  if (authorityProfile.promotionPolicy === 'named-two-person' && manifest.approvals !== undefined) {
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
}

export function validateCandidateManifest(manifest) {
  if (!isPlainObject(manifest)) {
    failManifest('root must be an object');
  }
  const legacyV1 = manifest.schemaVersion === 'cotsel.candidate-manifest.v1';
  if (!legacyV1 && manifest.schemaVersion !== 'cotsel.candidate-manifest.v2') {
    failManifest('schemaVersion must be cotsel.candidate-manifest.v1 or v2');
  }
  requireString(failManifest, manifest.candidateId, 'candidateId', CANDIDATE_ID_PATTERN);
  requireEnum(failManifest, manifest.status, 'status', MANIFEST_STATUSES);
  if (legacyV1 && manifest.status !== 'superseded') {
    failManifest('v1 manifests are historical and must have superseded status');
  }
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
  if (
    manifest.status === 'draft' &&
    (!Array.isArray(manifest.activationBlockers) ||
      manifest.activationBlockers.length === 0 ||
      manifest.activationBlockers.some(
        (blocker) => typeof blocker !== 'string' || blocker.trim().length === 0,
      ))
  ) {
    failManifest('draft status requires at least one activation blocker');
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
  assertCrossRepositoryManifestBinding(manifest);
  if (legacyV1) {
    validateLegacyInventory(manifest);
  } else {
    validateCandidateInventory(manifest);
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

  validateApprovals(manifest);
  validatePromotion(manifest);
  return manifest;
}

export function assertCandidateBindable(manifest) {
  if (!['candidate', 'promoted'].includes(manifest.status)) {
    failManifest(`status ${manifest.status} cannot bind evidence`);
  }
  assertEvidenceBindingAllowed(failManifest, authorityProfileForManifest(manifest));
  return manifest;
}
