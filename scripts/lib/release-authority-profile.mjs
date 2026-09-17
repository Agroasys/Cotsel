import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTANCE_ROLES,
  ENVIRONMENTS,
  IDENTITY_PATTERN,
  failManifest,
  isPlainObject,
  requireEnum,
  requireString,
} from './release-evidence-validation.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(LIB_DIR, '../..');
const AUTHORITY_PROFILE_PATH = path.join(ROOT_DIR, 'integration/release-authority-profile.json');
const AUTHORITY_PROMOTION_POLICIES = ['named-two-person', 'blocked'];

function profileFailure(message) {
  throw new Error(`Release authority profile ${message}`);
}

function validateNamedTwoPersonAuthorityProfile(profile) {
  for (const role of ACCEPTANCE_ROLES) {
    requireString(
      profileFailure,
      profile.approvalRoles?.[role],
      `approvalRoles.${role}`,
      IDENTITY_PATTERN,
    );
  }

  const namedIdentities = new Set(Object.values(profile.approvalRoles));
  if (namedIdentities.size !== 2) {
    profileFailure('must name exactly two approval identities');
  }

  for (const identity of namedIdentities) {
    const reviewer = profile.evidenceReviewers?.[identity];
    requireString(profileFailure, reviewer, `evidenceReviewers.${identity}`, IDENTITY_PATTERN);
    if (reviewer === identity || !namedIdentities.has(reviewer)) {
      profileFailure(`reviewer for ${identity} must be the other named identity`);
    }
  }

  if (
    !Array.isArray(profile.automatedEvidenceProducers) ||
    profile.automatedEvidenceProducers.some((identity) => !IDENTITY_PATTERN.test(identity))
  ) {
    profileFailure('automatedEvidenceProducers must be canonical handles');
  }
}

export function validateAuthorityProfileRegistry(registry) {
  if (!isPlainObject(registry)) {
    profileFailure('registry must be an object');
  }
  if (registry.schemaVersion !== 'cotsel.release-authority-profiles.v1') {
    profileFailure('registry has an unsupported schemaVersion');
  }
  if (!Array.isArray(registry.profiles)) {
    profileFailure('registry profiles must be an array');
  }

  const profilesByEnvironment = new Map();
  for (const profile of registry.profiles) {
    if (!isPlainObject(profile)) {
      profileFailure('must be an object');
    }
    requireString(profileFailure, profile.profileId, 'profileId', IDENTITY_PATTERN);
    requireEnum(profileFailure, profile.environment, 'environment', ENVIRONMENTS);
    requireEnum(
      profileFailure,
      profile.promotionPolicy,
      'promotionPolicy',
      AUTHORITY_PROMOTION_POLICIES,
    );
    if (profilesByEnvironment.has(profile.environment)) {
      profileFailure(`registry duplicates ${profile.environment}`);
    }
    if (profile.promotionPolicy === 'named-two-person') {
      validateNamedTwoPersonAuthorityProfile(profile);
    } else {
      requireString(profileFailure, profile.promotionBlocker, 'promotionBlocker');
    }
    profilesByEnvironment.set(profile.environment, profile);
  }

  for (const environment of ENVIRONMENTS) {
    if (!profilesByEnvironment.has(environment)) {
      profileFailure(`registry has no profile for ${environment}`);
    }
  }
  return profilesByEnvironment;
}

const AUTHORITY_PROFILE_REGISTRY = JSON.parse(fs.readFileSync(AUTHORITY_PROFILE_PATH, 'utf8'));
const AUTHORITY_PROFILES_BY_ENVIRONMENT = validateAuthorityProfileRegistry(
  AUTHORITY_PROFILE_REGISTRY,
);

export function authorityProfileForManifest(manifest) {
  const environment = manifest.environment?.name;
  const profile = AUTHORITY_PROFILES_BY_ENVIRONMENT.get(environment);
  if (!profile) {
    failManifest(`environment ${environment ?? '<missing>'} has no authority profile`);
  }
  return profile;
}

export function assertPromotionAllowed(fail, profile) {
  if (profile.promotionPolicy !== 'named-two-person') {
    fail(`promotion for ${profile.environment} is blocked: ${profile.promotionBlocker}`);
  }
}

export function assertEvidenceBindingAllowed(fail, profile) {
  if (profile.promotionPolicy !== 'named-two-person') {
    fail(`evidence binding for ${profile.environment} is blocked: ${profile.promotionBlocker}`);
  }
}

export function requireProfileRoleIdentity(fail, profile, role, identity, label) {
  const expectedIdentity = profile.approvalRoles[role];
  if (identity !== expectedIdentity) {
    fail(`${label} must be ${expectedIdentity} under ${profile.profileId}`);
  }
}

export function requireRecusedEvidenceReviewer(
  fail,
  profile,
  producerIdentity,
  reviewerIdentity,
  label,
) {
  const requiredReviewer = profile.evidenceReviewers[producerIdentity];
  if (requiredReviewer && reviewerIdentity !== requiredReviewer) {
    fail(`${label} produced by ${producerIdentity} must be reviewed by ${requiredReviewer}`);
  }
}

export function requireAuthorizedEvidenceProducer(fail, profile, identity, label) {
  const isNamedParticipant = Object.hasOwn(profile.evidenceReviewers, identity);
  const isApprovedAutomation = profile.automatedEvidenceProducers.includes(identity);
  if (!isNamedParticipant && !isApprovedAutomation) {
    fail(`${label} producer ${identity} is not authorized under ${profile.profileId}`);
  }
}
