import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertCandidateBindable,
  candidateIdentityDigest,
  validateCandidateManifest,
} from '../check-release-evidence-binding.mjs';
import {
  expectedMigrationIdentities,
  releaseCandidateInventory,
} from '../lib/release-candidate-inventory.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_PATH = path.join(
  ROOT_DIR,
  'scripts/tests/fixtures/release-evidence/candidate-manifest.json',
);

function fixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

function names(values, key = 'name') {
  return values.map((value) => value[key]).sort();
}

function terraformSet(filePath, localName) {
  const source = readFileSync(path.join(ROOT_DIR, filePath), 'utf8');
  const block = source.match(new RegExp(`${localName} = toset\\(\\[([\\s\\S]*?)\\]\\)`, 'u'));
  assert.ok(block, `${localName} must remain an explicit Terraform set`);
  return [...block[1].matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]).sort();
}

test('the release candidate inventory names the complete expected artifact and migration set', () => {
  const inventory = releaseCandidateInventory();
  assert.equal(inventory.schemaVersion, 'cotsel.release-candidate-inventory.v1');
  assert.equal(inventory.artifacts.length, 14);
  assert.deepEqual(names(inventory.migrations, 'component'), [
    'auth',
    'gateway',
    'indexer',
    'oracle',
    'reconciliation',
    'ricardian',
    'treasury',
  ]);
});

test('Terraform and the image workflow match the authoritative Cotsel image inventory', () => {
  const inventory = releaseCandidateInventory();
  const expectedImages = inventory.artifacts.filter(
    (artifact) =>
      artifact.kind === 'container-image' && artifact.sourceRepository === 'Agroasys/Cotsel',
  );
  const expectedNames = names(expectedImages);
  assert.deepEqual(
    terraformSet('infra/terraform/staging-platform/naming.tf', 'services'),
    expectedNames,
  );

  const runtimeImages = readFileSync(
    path.join(ROOT_DIR, 'infra/terraform/staging-platform/runtime-images.tf'),
    'utf8',
  );
  assert.match(runtimeImages, /runtime_services = local\.services/u);
  assert.doesNotMatch(runtimeImages, /runtime_services = toset/u);

  const workflow = readFileSync(
    path.join(ROOT_DIR, '.github/workflows/release-images.yml'),
    'utf8',
  );
  const workflowServices = [...workflow.matchAll(/^\s+- service: ([a-z0-9-]+)$/gmu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(workflowServices, expectedNames);
  for (const artifact of expectedImages) {
    assert.match(workflow, new RegExp(`repository: ${artifact.repository}`, 'u'));
    assert.match(workflow, new RegExp(`dockerfile: ${artifact.dockerfile}`, 'u'));
    assert.match(workflow, new RegExp(`local_tag: ${artifact.localTag}`, 'u'));
  }
});

test('the expected migration identities come from every reviewed source manifest', () => {
  assert.deepEqual(fixture().migrations, expectedMigrationIdentities());
});

test('Terraform migration tasks match the release candidate migration inventory', () => {
  const serviceMigrations = readFileSync(
    path.join(ROOT_DIR, 'infra/terraform/staging-platform/service-migrations.tf'),
    'utf8',
  );
  const configured = [...serviceMigrations.matchAll(/^\s{4}([a-z]+) = \{$/gmu)].map(
    (match) => match[1],
  );
  const indexerMigration = readFileSync(
    path.join(ROOT_DIR, 'infra/terraform/staging-platform/indexer-migration.tf'),
    'utf8',
  );
  assert.match(indexerMigration, /resource "aws_ecs_task_definition" "indexer_migration"/u);
  assert.deepEqual(
    [...configured, 'indexer'].sort(),
    names(releaseCandidateInventory().migrations, 'component'),
  );
});

test('a complete v2 candidate validates and binds', () => {
  const manifest = fixture();
  assert.doesNotThrow(() => validateCandidateManifest(manifest));
  assert.doesNotThrow(() => assertCandidateBindable(manifest));
});

test('candidate validation rejects a mismatched cross-repository manifest digest', () => {
  const manifest = fixture();
  manifest.crossRepositoryManifest.sha256 = '0'.repeat(64);

  assert.throws(
    () => validateCandidateManifest(manifest),
    /crossRepositoryManifest\.sha256 .* does not match integration\/release-manifest\.json/,
  );
});

test('a one-artifact candidate is rejected', () => {
  const manifest = fixture();
  manifest.artifacts = [manifest.artifacts[0]];
  assert.throws(() => validateCandidateManifest(manifest), /required artifact gateway is missing/);
});

test('missing, duplicate, and unexpected artifacts are rejected', () => {
  const missing = fixture();
  missing.artifacts = missing.artifacts.filter((artifact) => artifact.name !== 'relayer');
  assert.throws(() => validateCandidateManifest(missing), /required artifact relayer is missing/);

  const duplicate = fixture();
  duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
  assert.throws(() => validateCandidateManifest(duplicate), /duplicate artifact auth/);

  const unexpected = fixture();
  unexpected.artifacts.push({ ...structuredClone(unexpected.artifacts[0]), name: 'unknown' });
  assert.throws(() => validateCandidateManifest(unexpected), /unexpected artifact unknown/);
});

test('mutable image references and incorrect source identities are rejected', () => {
  const mutable = fixture();
  mutable.artifacts[0].reference = 'example.invalid/cotsel/auth:latest';
  assert.throws(
    () => validateCandidateManifest(mutable),
    /reference must use its immutable digest/,
  );

  const wrongCommit = fixture();
  wrongCommit.artifacts.find((artifact) => artifact.name === 'Cotsel-Dash').sourceCommit =
    '0'.repeat(40);
  assert.throws(
    () => validateCandidateManifest(wrongCommit),
    /sourceCommit does not match its pinned repository commit/,
  );

  const wrongWorkflow = fixture();
  wrongWorkflow.artifacts[0].producingWorkflow = '.github/workflows/unknown.yml';
  assert.throws(
    () => validateCandidateManifest(wrongWorkflow),
    /producingWorkflow does not match the deployment inventory/,
  );
});

test('unverified provenance, SBOM evidence, and artifact status are rejected', () => {
  const provenance = fixture();
  provenance.artifacts[0].provenance.verified = false;
  assert.throws(() => validateCandidateManifest(provenance), /provenance must be verified/);

  const sbom = fixture();
  sbom.artifacts[0].sbom.verified = false;
  assert.throws(() => validateCandidateManifest(sbom), /SBOM must be verified/);

  const verification = fixture();
  verification.artifacts[0].verificationStatus = 'unverified';
  assert.throws(
    () => validateCandidateManifest(verification),
    /verificationStatus must be verified/,
  );
});

test('missing, duplicate, unexpected, and incorrect migrations are rejected', () => {
  const missing = fixture();
  missing.migrations = missing.migrations.filter((migration) => migration.component !== 'gateway');
  assert.throws(
    () => validateCandidateManifest(missing),
    /required migration component gateway is missing/,
  );

  const duplicate = fixture();
  duplicate.migrations.push(structuredClone(duplicate.migrations[0]));
  assert.throws(() => validateCandidateManifest(duplicate), /duplicate migration component auth/);

  const unexpected = fixture();
  unexpected.migrations.push({
    component: 'unknown',
    headIdentity: '1_unknown',
    checksumSha256: '0'.repeat(64),
  });
  assert.throws(
    () => validateCandidateManifest(unexpected),
    /unexpected migration component unknown/,
  );

  const incorrect = fixture();
  incorrect.migrations[0].checksumSha256 = '0'.repeat(64);
  assert.throws(
    () => validateCandidateManifest(incorrect),
    /does not match the reviewed source manifest/,
  );
});

test('artifact evidence and migration checksums are part of the candidate identity', () => {
  const original = fixture();
  const provenanceChanged = fixture();
  provenanceChanged.artifacts[0].producingRunId = 'different-run';
  assert.notEqual(candidateIdentityDigest(provenanceChanged), candidateIdentityDigest(original));

  const migrationChanged = fixture();
  migrationChanged.migrations[0].checksumSha256 = '0'.repeat(64);
  assert.notEqual(candidateIdentityDigest(migrationChanged), candidateIdentityDigest(original));
});

test('historical v1 manifests remain readable but cannot authorize new evidence', () => {
  const historical = fixture();
  historical.schemaVersion = 'cotsel.candidate-manifest.v1';
  historical.status = 'superseded';
  historical.artifacts = historical.artifacts.map(({ name, kind, digest }) => ({
    name,
    kind: kind === 'web-bundle' ? 'contract-bundle' : kind,
    digest,
  }));
  assert.doesNotThrow(() => validateCandidateManifest(historical));
  assert.throws(
    () => assertCandidateBindable(historical),
    /status superseded cannot bind evidence/,
  );

  historical.status = 'candidate';
  assert.throws(
    () => validateCandidateManifest(historical),
    /v1 manifests are historical and must have superseded status/,
  );
});

test('the published v2 schema describes the inventory cardinality and artifact evidence', () => {
  const schema = JSON.parse(
    readFileSync(path.join(ROOT_DIR, 'integration/candidate-manifest.v2.schema.json'), 'utf8'),
  );
  const inventory = releaseCandidateInventory();
  assert.equal(schema.properties.schemaVersion.const, 'cotsel.candidate-manifest.v2');
  assert.equal(schema.properties.artifacts.minItems, inventory.artifacts.length);
  assert.equal(schema.properties.artifacts.maxItems, inventory.artifacts.length);
  assert.equal(schema.properties.migrations.minItems, inventory.migrations.length);
  assert.equal(schema.properties.migrations.maxItems, inventory.migrations.length);
  assert.deepEqual(schema.$defs.artifact.required.sort(), [
    'digest',
    'kind',
    'name',
    'producingRunId',
    'producingWorkflow',
    'provenance',
    'sbom',
    'sourceCommit',
    'sourceRepository',
    'verificationStatus',
  ]);
  assert.deepEqual(schema.$defs.artifact.allOf, [
    {
      if: { properties: { kind: { const: 'container-image' } } },
      then: { required: ['reference'] },
    },
  ]);
});
