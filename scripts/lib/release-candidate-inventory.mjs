import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INVENTORY_PATH = path.join(ROOT_DIR, 'integration/release-candidate-inventory.json');
const RELEASE_MANIFEST_PATH = path.join(ROOT_DIR, 'integration/release-manifest.json');
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`Candidate manifest invalid: ${message}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} is required`);
  }
  if (pattern && !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
}

function requireExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} fields must be exactly ${expected.join(', ')}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadInventory() {
  const inventory = readJson(INVENTORY_PATH);
  if (inventory.schemaVersion !== 'cotsel.release-candidate-inventory.v1') {
    throw new Error('Release candidate inventory has an unsupported schemaVersion');
  }
  if (!Array.isArray(inventory.artifacts) || !Array.isArray(inventory.migrations)) {
    throw new Error('Release candidate inventory must declare artifacts and migrations');
  }
  for (const collectionName of ['artifacts', 'migrations']) {
    const identity = collectionName === 'artifacts' ? 'name' : 'component';
    const values = inventory[collectionName].map((entry) => entry[identity]);
    if (new Set(values).size !== values.length) {
      throw new Error(`Release candidate inventory duplicates a ${collectionName} identity`);
    }
  }
  return inventory;
}

const INVENTORY = loadInventory();
const RELEASE_MANIFEST = readJson(RELEASE_MANIFEST_PATH);

export function releaseCandidateInventory() {
  return structuredClone(INVENTORY);
}

function expectedSourceCommit(artifact, manifest) {
  if (artifact.sourceRepository === 'Agroasys/Cotsel') {
    return manifest.source.commit;
  }
  const repository = RELEASE_MANIFEST.repositories?.find(
    (entry) => entry.repository === artifact.sourceRepository,
  );
  if (!repository) {
    fail(
      `artifact ${artifact.name} source repository is absent from the cross-repository manifest`,
    );
  }
  return repository.commit;
}

function validateProvenance(actual, artifactName) {
  if (!isObject(actual)) {
    fail(`artifact ${artifactName} provenance is required`);
  }
  requireExactKeys(actual, ['uri', 'sha256', 'verified'], `artifact ${artifactName} provenance`);
  requireString(actual.uri, `artifact ${artifactName} provenance.uri`);
  requireString(actual.sha256, `artifact ${artifactName} provenance.sha256`, SHA256_PATTERN);
  if (actual.verified !== true) {
    fail(`artifact ${artifactName} provenance must be verified`);
  }
}

function validateSbom(actual, expected, artifactName) {
  if (!isObject(actual) || actual.required !== expected.sbomRequired) {
    fail(`artifact ${artifactName} SBOM requirement does not match the deployment inventory`);
  }
  if (expected.sbomRequired) {
    requireExactKeys(
      actual,
      ['required', 'uri', 'sha256', 'verified'],
      `artifact ${artifactName} sbom`,
    );
    requireString(actual.uri, `artifact ${artifactName} sbom.uri`);
    requireString(actual.sha256, `artifact ${artifactName} sbom.sha256`, SHA256_PATTERN);
    if (actual.verified !== true) {
      fail(`artifact ${artifactName} SBOM must be verified`);
    }
    return;
  }
  requireExactKeys(actual, ['required', 'rationale'], `artifact ${artifactName} sbom`);
  requireString(actual.rationale, `artifact ${artifactName} sbom.rationale`);
}

function validateArtifact(actual, expected, manifest) {
  if (!isObject(actual)) {
    fail(`artifact ${expected.name} must be an object`);
  }
  const expectedKeys = [
    'name',
    'kind',
    'digest',
    'sourceRepository',
    'sourceCommit',
    'producingWorkflow',
    'producingRunId',
    'provenance',
    'sbom',
    'verificationStatus',
  ];
  if (expected.kind === 'container-image') {
    expectedKeys.push('reference');
  }
  requireExactKeys(actual, expectedKeys, `artifact ${expected.name}`);
  if (actual.name !== expected.name || actual.kind !== expected.kind) {
    fail(`artifact ${expected.name} kind or name does not match the deployment inventory`);
  }
  requireString(actual.digest, `artifact ${expected.name} digest`, DIGEST_PATTERN);
  if (actual.sourceRepository !== expected.sourceRepository) {
    fail(`artifact ${expected.name} sourceRepository does not match the deployment inventory`);
  }
  requireString(actual.sourceCommit, `artifact ${expected.name} sourceCommit`, COMMIT_PATTERN);
  if (actual.sourceCommit !== expectedSourceCommit(expected, manifest)) {
    fail(`artifact ${expected.name} sourceCommit does not match its pinned repository commit`);
  }
  if (actual.producingWorkflow !== expected.producingWorkflow) {
    fail(`artifact ${expected.name} producingWorkflow does not match the deployment inventory`);
  }
  requireString(actual.producingRunId, `artifact ${expected.name} producingRunId`);
  if (expected.kind === 'container-image') {
    requireString(actual.reference, `artifact ${expected.name} reference`);
    if (!actual.reference.endsWith(`@${actual.digest}`)) {
      fail(`artifact ${expected.name} reference must use its immutable digest`);
    }
  }
  validateProvenance(actual.provenance, expected.name);
  validateSbom(actual.sbom, expected, expected.name);
  if (actual.verificationStatus !== 'verified') {
    fail(`artifact ${expected.name} verificationStatus must be verified`);
  }
}

function expectedMigration(entry) {
  const migrationManifest = readJson(path.join(ROOT_DIR, entry.manifestPath));
  if (!Array.isArray(migrationManifest.migrations) || migrationManifest.migrations.length === 0) {
    throw new Error(`Migration manifest ${entry.manifestPath} has no migrations`);
  }
  const head = migrationManifest.migrations.at(-1);
  return {
    component: entry.component,
    headIdentity: `${head.version}_${head.name}`,
    checksumSha256: sha256(canonicalize(migrationManifest.migrations)),
  };
}

export function expectedMigrationIdentities() {
  return INVENTORY.migrations.map((entry) => expectedMigration(entry));
}

export function validateCandidateInventory(manifest) {
  if (!Array.isArray(manifest.artifacts)) {
    fail('artifacts must be an array');
  }
  const actualArtifacts = new Map();
  for (const artifact of manifest.artifacts) {
    requireString(artifact?.name, 'artifact.name');
    if (actualArtifacts.has(artifact.name)) {
      fail(`duplicate artifact ${artifact.name}`);
    }
    actualArtifacts.set(artifact.name, artifact);
  }
  const expectedArtifacts = new Map(INVENTORY.artifacts.map((entry) => [entry.name, entry]));
  for (const name of expectedArtifacts.keys()) {
    if (!actualArtifacts.has(name)) {
      fail(`required artifact ${name} is missing`);
    }
  }
  for (const name of actualArtifacts.keys()) {
    if (!expectedArtifacts.has(name)) {
      fail(`unexpected artifact ${name}`);
    }
  }
  for (const [name, expected] of expectedArtifacts) {
    validateArtifact(actualArtifacts.get(name), expected, manifest);
  }

  if (!Array.isArray(manifest.migrations)) {
    fail('migrations must be an array');
  }
  const actualMigrations = new Map();
  for (const migration of manifest.migrations) {
    requireString(migration?.component, 'migration.component');
    if (actualMigrations.has(migration.component)) {
      fail(`duplicate migration component ${migration.component}`);
    }
    actualMigrations.set(migration.component, migration);
  }
  const expectedMigrations = expectedMigrationIdentities();
  for (const expected of expectedMigrations) {
    const actual = actualMigrations.get(expected.component);
    if (!actual) {
      fail(`required migration component ${expected.component} is missing`);
    }
    requireExactKeys(
      actual,
      ['component', 'headIdentity', 'checksumSha256'],
      `migration ${expected.component}`,
    );
    if (
      actual.headIdentity !== expected.headIdentity ||
      actual.checksumSha256 !== expected.checksumSha256
    ) {
      fail(`migration ${expected.component} does not match the reviewed source manifest`);
    }
  }
  for (const component of actualMigrations.keys()) {
    if (!expectedMigrations.some((entry) => entry.component === component)) {
      fail(`unexpected migration component ${component}`);
    }
  }
}

export function artifactIdentityDigests(manifest) {
  return manifest.artifacts.map((artifact) => `sha256:${sha256(canonicalize(artifact))}`).sort();
}

export function migrationIdentityStrings(manifest) {
  return manifest.migrations
    .map(
      (migration) =>
        `${migration.component}@${migration.headIdentity}#sha256:${migration.checksumSha256}`,
    )
    .sort();
}
