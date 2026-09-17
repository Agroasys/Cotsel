import {
  ACCEPTANCE_ROLES,
  ADDRESS_PATTERN,
  BASE_MAINNET_CHAIN_ID,
  CANDIDATE_ID_PATTERN,
  COMMIT_PATTERN,
  CONTROL_ID_PATTERN,
  DIGEST_PATTERN,
  ENVIRONMENTS,
  IDENTITY_PATTERN,
  ISSUE_PATTERN,
  REVIEW_DECISIONS,
  ROUTE_PATTERN,
  SHA256_PATTERN,
  canonicalize,
  failIndex,
  isPlainObject,
  normalizeProviderMode,
  requireEnum,
  requireInteger,
  requireString,
  requireTimestamp,
  validateProviderMode,
} from './release-evidence-validation.mjs';
import {
  assertCandidateBindable,
  candidateIdentity,
  candidateIdentityDigest,
  IDENTITY_DIMENSIONS,
  validateCandidateManifest,
} from './release-candidate-manifest.mjs';
import {
  authorityProfileForManifest,
  requireAuthorizedEvidenceProducer,
  requireProfileRoleIdentity,
  requireRecusedEvidenceReviewer,
} from './release-authority-profile.mjs';

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
  requireProfileRoleIdentity(
    failIndex,
    authorityProfile,
    equivalence.role,
    equivalence.acceptedBy,
    `${label} equivalence acceptedBy`,
  );
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

function validateEvidenceEntry(entry, position, expected, authorityProfile, now, seenArtifacts) {
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
  requireString(failIndex, entry.reviewer.identity, `${label} reviewer identity`, IDENTITY_PATTERN);
  requireEnum(failIndex, entry.reviewer.role, `${label} reviewer role`, ACCEPTANCE_ROLES);
  requireEnum(failIndex, entry.reviewer.decision, `${label} reviewer decision`, REVIEW_DECISIONS);
  requireTimestamp(failIndex, entry.reviewer.reviewedAt, `${label} reviewer reviewedAt`);
  if (entry.reviewer.identity === entry.producedBy.identity) {
    failIndex(
      `${label} was accepted by its own producer; review by the other participant is required`,
    );
  }
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
    const crossesMainnet =
      (dimension === 'chainId' &&
        (actual.chainId === BASE_MAINNET_CHAIN_ID || expected.chainId === BASE_MAINNET_CHAIN_ID)) ||
      (dimension === 'environment' &&
        (actual.environment === 'base-mainnet' || expected.environment === 'base-mainnet'));
    if (crossesMainnet) {
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
  index.entries.forEach((entry, position) =>
    validateEvidenceEntry(entry, position, expected, authorityProfile, now, seenArtifacts),
  );
  return index;
}

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
