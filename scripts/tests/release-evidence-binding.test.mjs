import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  IDENTITY_DIMENSIONS,
  assertCandidateBindable,
  assertCrossRepositoryManifestBinding,
  assertEvidenceIndexComplete,
  canonicalDigest,
  candidateIdentityDigest,
  readCandidateManifest,
  readJsonDocument,
  validateCandidateManifest,
  validateEvidenceIndex,
} from '../check-release-evidence-binding.mjs';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TESTS_DIR, '../..');
const FIXTURE_DIR = path.join(TESTS_DIR, 'fixtures/release-evidence');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'candidate-manifest.json');
const INDEX_PATH = path.join(FIXTURE_DIR, 'evidence-index.json');
const NOW = '2026-08-05T12:00:00.000Z';

const manifestFixture = () => structuredClone(readJsonDocument(MANIFEST_PATH));
const indexFixture = () => structuredClone(readJsonDocument(INDEX_PATH));

/** Rebinds an index to a manifest after the manifest identity was deliberately changed. */
function rebind(index, manifest) {
  const digest = candidateIdentityDigest(manifest);
  index.candidateId = manifest.candidateId;
  index.manifest.sha256 = digest;
  index.environmentReport.manifestSha256 = digest;
  index.environmentReport.configDigestSha256 = manifest.configDigest.sha256;
  return index;
}

test('accepts the checked-in candidate manifest and evidence index fixtures', () => {
  const manifest = readCandidateManifest(MANIFEST_PATH);
  const index = validateEvidenceIndex(indexFixture(), manifest, { now: NOW });

  assert.equal(manifest.owner.role, 'Release Owner');
  assert.equal(index.entries.length, 2);
  assert.doesNotThrow(() => assertEvidenceIndexComplete(index, ['REPORT-02', 'PROG-01']));
});

test('the candidate identity survives promotion but not an identity change', () => {
  const candidate = manifestFixture();
  const promoted = manifestFixture();
  promoted.status = 'promoted';
  promoted.approvals = [
    {
      role: 'Release Owner',
      identity: 'release-owner@example.invalid',
      decision: 'approved',
      decidedAt: NOW,
    },
    {
      role: 'Security reviewer',
      identity: 'security@example.invalid',
      decision: 'approved',
      decidedAt: NOW,
    },
    {
      role: 'Operations reviewer',
      identity: 'ops@example.invalid',
      decision: 'approved',
      decidedAt: NOW,
    },
  ];

  // Lifecycle metadata is not identity: evidence accepted for a candidate stays bound after promotion.
  assert.equal(candidateIdentityDigest(promoted), candidateIdentityDigest(candidate));
  assert.doesNotThrow(() => validateEvidenceIndex(indexFixture(), promoted, { now: NOW }));

  const rebuilt = manifestFixture();
  rebuilt.artifacts[0].digest = `sha256:${'b'.repeat(64)}`;
  assert.notEqual(candidateIdentityDigest(rebuilt), candidateIdentityDigest(candidate));
});

test('rejects an evidence index bound to another build', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  index.manifest.sha256 = 'c'.repeat(64);

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /does not resolve to the promoted candidate identity/,
  );
});

test('rejects an evidence index bound to another candidate', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  index.candidateId = 'cotsel-2026-07-01-earlier';

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /does not match manifest/,
  );
});

/**
 * REPORT-02 and PROG-01: a changed commit, artifact digest, environment, chain, contract address,
 * migration, provider mode or configuration digest must invalidate the evidence.
 */
const staleMutations = {
  sourceCommit: (entry) => {
    entry.boundIdentity.sourceCommit = 'a'.repeat(40);
  },
  artifactDigests: (entry) => {
    entry.boundIdentity.artifactDigests[0] = `sha256:${'d'.repeat(64)}`;
  },
  environment: (entry) => {
    entry.boundIdentity.environment = 'local-ci';
  },
  chainId: (entry) => {
    entry.boundIdentity.chainId = 31337;
  },
  contractAddress: (entry) => {
    entry.boundIdentity.contractAddress = '0x000000000000000000000000000000000000dead';
  },
  // A proxy upgrade or a different compiler setting moves the implementation under a stable address.
  contractDeployedBytecodeSha256: (entry) => {
    entry.boundIdentity.contractDeployedBytecodeSha256 = 'b'.repeat(64);
  },
  migrationIdentities: (entry) => {
    entry.boundIdentity.migrationIdentities[0] = 'indexer@0041_previous_head';
  },
  providerMode: (entry) => {
    entry.boundIdentity.providerMode.fiatOffRamp = 'sandbox';
  },
  configDigestSha256: (entry) => {
    entry.boundIdentity.configDigestSha256 = 'e'.repeat(64);
  },
};

test('covers every identity dimension the SOW names', () => {
  assert.deepEqual(Object.keys(staleMutations).sort(), [...IDENTITY_DIMENSIONS].sort());
});

for (const [dimension, mutate] of Object.entries(staleMutations)) {
  test(`rejects evidence produced against a different ${dimension}`, () => {
    const manifest = manifestFixture();
    const index = indexFixture();
    mutate(index.entries[0]);

    assert.throws(
      () => validateEvidenceIndex(index, manifest, { now: NOW }),
      new RegExp(`was produced against a different ${dimension}`),
    );
  });

  test(`accepts a bounded, unexpired equivalence for ${dimension}`, () => {
    const manifest = manifestFixture();
    const index = indexFixture();
    mutate(index.entries[0]);
    index.entries[0].equivalence = {
      dimensions: [dimension],
      acceptedBy: 'release-owner@example.invalid',
      role: 'Release Owner',
      rationale: `Reviewed ${dimension} difference and confirmed it cannot affect this control.`,
      expiresAt: '2026-09-01T00:00:00.000Z',
    };

    assert.doesNotThrow(() => validateEvidenceIndex(index, manifest, { now: NOW }));
  });
}

test('rejects an expired equivalence', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  staleMutations.sourceCommit(index.entries[0]);
  index.entries[0].equivalence = {
    dimensions: ['sourceCommit'],
    acceptedBy: 'release-owner@example.invalid',
    role: 'Release Owner',
    rationale: 'Documentation-only difference.',
    expiresAt: '2026-08-01T00:00:00.000Z',
  };

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /equivalence expired at/,
  );
});

test('rejects an equivalence that covers a different dimension than the one that drifted', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  staleMutations.contractAddress(index.entries[0]);
  index.entries[0].equivalence = {
    dimensions: ['sourceCommit'],
    acceptedBy: 'release-owner@example.invalid',
    role: 'Release Owner',
    rationale: 'Wrong dimension accepted.',
    expiresAt: '2026-09-01T00:00:00.000Z',
  };

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /was produced against a different contractAddress/,
  );
});

test('rejects an equivalence for a dimension that did not drift', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  index.entries[0].equivalence = {
    dimensions: ['providerMode'],
    acceptedBy: 'release-owner@example.invalid',
    role: 'Release Owner',
    rationale: 'Blanket acceptance attempt.',
    expiresAt: '2026-09-01T00:00:00.000Z',
  };

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /accepts equivalence for providerMode, which does not differ/,
  );
});

test('refuses to carry rehearsal evidence across the Base mainnet boundary', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  index.entries[0].boundIdentity.chainId = 8453;
  index.entries[0].equivalence = {
    dimensions: ['chainId'],
    acceptedBy: 'release-owner@example.invalid',
    role: 'Release Owner',
    rationale: 'Attempt to promote rehearsal proof to mainnet.',
    expiresAt: '2026-09-01T00:00:00.000Z',
  };

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /Base mainnet boundary, which is not waivable/,
  );
});

test('rejects an environment report bound to a different candidate or configuration', () => {
  const manifest = manifestFixture();

  const staleManifestBinding = indexFixture();
  staleManifestBinding.environmentReport.manifestSha256 = 'f'.repeat(64);
  assert.throws(
    () => validateEvidenceIndex(staleManifestBinding, manifest, { now: NOW }),
    /environmentReport is bound to a different candidate identity/,
  );

  const staleConfigBinding = indexFixture();
  staleConfigBinding.environmentReport.configDigestSha256 = '0'.repeat(64);
  assert.throws(
    () => validateEvidenceIndex(staleConfigBinding, manifest, { now: NOW }),
    /environmentReport configuration digest does not match/,
  );
});

test('rejects evidence accepted by its own producer', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  index.entries[0].reviewer.identity = index.entries[0].producedBy.identity;

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /review by the other participant is required/,
  );
});

test('rejects an equivalence accepted by the producer of the evidence it waives', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  staleMutations.configDigestSha256(index.entries[0]);
  index.entries[0].equivalence = {
    dimensions: ['configDigestSha256'],
    acceptedBy: index.entries[0].producedBy.identity,
    role: 'Release Owner',
    rationale: 'Producer certifying their own stale evidence.',
    expiresAt: '2026-09-01T00:00:00.000Z',
  };

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /equivalence was accepted by its own producer; review by the other participant is required/,
  );
});

/** A reviewer accepting an equivalence for evidence someone else produced is still two people. */
test('allows the reviewer of an entry to accept its equivalence', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  staleMutations.configDigestSha256(index.entries[0]);
  index.entries[0].equivalence = {
    dimensions: ['configDigestSha256'],
    acceptedBy: index.entries[0].reviewer.identity,
    role: index.entries[0].reviewer.role,
    rationale: 'Log verbosity only; no settlement, signer or provider setting changed.',
    expiresAt: '2026-09-01T00:00:00.000Z',
  };

  assert.doesNotThrow(() => validateEvidenceIndex(index, manifest, { now: NOW }));
});

/**
 * The two-person control is string equality on identities, so the identity format is part of the
 * control: one person must not be able to appear as `avitus`, `AvitusI` and `Avitus I`.
 */
test('rejects actor identities outside the canonical handle format', () => {
  for (const mutate of [
    (index) => {
      index.entries[0].producedBy.identity = 'Avitus I';
    },
    (index) => {
      index.entries[0].reviewer.identity = 'ReleaseOwner@Example.invalid';
    },
    (index) => {
      staleMutations.sourceCommit(index.entries[0]);
      index.entries[0].equivalence = {
        dimensions: ['sourceCommit'],
        acceptedBy: 'Release Owner',
        role: 'Release Owner',
        rationale: 'Non-canonical acceptor.',
        expiresAt: '2026-09-01T00:00:00.000Z',
      };
    },
  ]) {
    const index = indexFixture();
    mutate(index);
    assert.throws(
      () => validateEvidenceIndex(index, manifestFixture(), { now: NOW }),
      /does not match/,
    );
  }

  const manifest = manifestFixture();
  manifest.status = 'promoted';
  manifest.approvals = [
    { role: 'Release Owner', identity: 'Release Owner', decision: 'approved', decidedAt: NOW },
  ];
  assert.throws(() => validateCandidateManifest(manifest), /identity does not match/);
});

test('rejects the same artifact indexed twice for one control', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  index.entries[1].controlId = index.entries[0].controlId;
  index.entries[1].artifact = structuredClone(index.entries[0].artifact);

  assert.throws(
    () => validateEvidenceIndex(index, manifest, { now: NOW }),
    /duplicates an artifact/,
  );
});

test('reports controls with no accepted evidence', () => {
  const manifest = manifestFixture();
  const index = indexFixture();
  index.entries[1].reviewer.decision = 'pending';
  validateEvidenceIndex(index, manifest, { now: NOW });

  assert.throws(
    () => assertEvidenceIndexComplete(index, ['REPORT-02', 'PROG-01']),
    /no accepted evidence for PROG-01/,
  );
});

test('only a candidate or promoted manifest can bind evidence', () => {
  const draft = manifestFixture();
  draft.status = 'draft';
  draft.activationBlockers = ['charter is not approved'];
  assert.doesNotThrow(() => validateCandidateManifest(draft));
  assert.throws(() => assertCandidateBindable(draft), /status draft cannot bind evidence/);

  const superseded = manifestFixture();
  superseded.status = 'superseded';
  assert.throws(
    () => validateEvidenceIndex(indexFixture(), superseded, { now: NOW }),
    /status superseded cannot bind evidence/,
  );
});

test('requires a draft to name its activation blockers', () => {
  const manifest = manifestFixture();
  manifest.status = 'draft';

  assert.throws(
    () => validateCandidateManifest(manifest),
    /draft status requires at least one activation blocker/,
  );
});

test('requires all three acceptance roles before a candidate is promoted', () => {
  const manifest = manifestFixture();
  manifest.status = 'promoted';
  manifest.approvals = [
    {
      role: 'Release Owner',
      identity: 'release-owner@example.invalid',
      decision: 'approved',
      decidedAt: NOW,
    },
    {
      role: 'Security reviewer',
      identity: 'security@example.invalid',
      decision: 'rejected',
      decidedAt: NOW,
    },
  ];

  assert.throws(
    () => validateCandidateManifest(manifest),
    /promoted status requires approval from Security reviewer, Operations reviewer/,
  );
});

test('requires two distinct identities for promotion while allowing role overlap', () => {
  const promoted = manifestFixture();
  promoted.status = 'promoted';
  promoted.approvals = [
    {
      role: 'Release Owner',
      identity: 'astton',
      decision: 'approved',
      decidedAt: NOW,
    },
    {
      role: 'Security reviewer',
      identity: 'czpyioe',
      decision: 'approved',
      decidedAt: NOW,
    },
    {
      role: 'Operations reviewer',
      identity: 'astton',
      decision: 'approved',
      decidedAt: NOW,
    },
  ];

  assert.doesNotThrow(() => validateCandidateManifest(promoted));

  const onePersonPromotion = structuredClone(promoted);
  onePersonPromotion.approvals = onePersonPromotion.approvals.map((approval) => ({
    ...approval,
    identity: 'astton',
  }));
  assert.throws(
    () => validateCandidateManifest(onePersonPromotion),
    /requires approval from two distinct identities/,
  );
});

test('keeps public participants and real commercial value out of rehearsal environments', () => {
  const withPublicUsers = manifestFixture();
  withPublicUsers.environment.publicParticipants = true;
  assert.throws(
    () => validateCandidateManifest(withPublicUsers),
    /cannot admit public participants/,
  );

  const withRealValue = manifestFixture();
  withRealValue.environment.realCommercialValue = true;
  assert.throws(
    () => validateCandidateManifest(withRealValue),
    /cannot carry real commercial value/,
  );

  const misclassified = manifestFixture();
  misclassified.environment.classification = 'production';
  assert.throws(() => validateCandidateManifest(misclassified), /cannot be classified production/);
});

test('keeps the declared chain and environment in agreement about Base mainnet', () => {
  const manifest = manifestFixture();
  manifest.chain.chainId = 8453;

  assert.throws(
    () => validateCandidateManifest(manifest),
    /chain\.chainId and environment\.name disagree about Base mainnet/,
  );
});

test('requires the configuration digest to be redacted', () => {
  const manifest = manifestFixture();
  manifest.configDigest.redacted = false;

  assert.throws(() => validateCandidateManifest(manifest), /raw configuration is never indexed/);
});

test('requires a rollback target that is not the candidate itself', () => {
  const manifest = manifestFixture();
  manifest.rollbackTarget = {
    kind: 'candidate',
    candidateId: manifest.candidateId,
    compatibilityNote: 'Self reference.',
  };

  assert.throws(() => validateCandidateManifest(manifest), /cannot be its own rollback target/);
});

test('binds the candidate to the checked-in cross-repository release manifest', () => {
  const releaseManifestPath = path.join(ROOT_DIR, 'integration/release-manifest.json');
  const manifest = manifestFixture();

  assert.throws(
    () => assertCrossRepositoryManifestBinding(manifest, releaseManifestPath),
    /crossRepositoryManifest\.sha256 .* does not match/,
  );

  manifest.crossRepositoryManifest.sha256 = canonicalDigest(readJsonDocument(releaseManifestPath));
  assert.doesNotThrow(() => assertCrossRepositoryManifestBinding(manifest, releaseManifestPath));
});

/**
 * The published JSON Schemas are the contract other repositories read. The hand-written validator
 * is what CI enforces. This proves the two agree on what is mandatory.
 */
test('the validator enforces every required property the published schemas declare', () => {
  const manifestSchema = readJsonDocument(
    path.join(ROOT_DIR, 'integration/candidate-manifest.schema.json'),
  );
  for (const property of manifestSchema.required) {
    const manifest = manifestFixture();
    delete manifest[property];
    assert.throws(
      () => validateCandidateManifest(manifest),
      /Candidate manifest invalid/,
      `removing ${property} must be rejected`,
    );
  }

  const indexSchema = readJsonDocument(
    path.join(ROOT_DIR, 'integration/evidence-index.schema.json'),
  );
  for (const property of indexSchema.required) {
    const index = indexFixture();
    delete index[property];
    assert.throws(
      () => validateEvidenceIndex(index, manifestFixture(), { now: NOW }),
      /Evidence index invalid/,
      `removing ${property} must be rejected`,
    );
  }

  const entrySchema = indexSchema.properties.entries.items;
  for (const property of entrySchema.required) {
    const index = indexFixture();
    delete index.entries[0][property];
    assert.throws(
      () => validateEvidenceIndex(index, manifestFixture(), { now: NOW }),
      /Evidence index invalid/,
      `removing entry ${property} must be rejected`,
    );
  }

  const boundIdentitySchema = entrySchema.properties.boundIdentity;
  // A dimension the schema records but the comparison loop ignores would bind nothing.
  assert.deepEqual([...boundIdentitySchema.required].sort(), [...IDENTITY_DIMENSIONS].sort());
  assert.deepEqual(
    [...entrySchema.properties.equivalence.properties.dimensions.items.enum].sort(),
    [...IDENTITY_DIMENSIONS].sort(),
  );
  for (const property of boundIdentitySchema.required) {
    const index = indexFixture();
    delete index.entries[0].boundIdentity[property];
    assert.throws(
      () => validateEvidenceIndex(index, manifestFixture(), { now: NOW }),
      /Evidence index invalid/,
      `removing boundIdentity ${property} must be rejected`,
    );
  }
});

const SCRIPT_PATH = path.join(TESTS_DIR, '../check-release-evidence-binding.mjs');

function runCli(indexPath, ...extra) {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--manifest', MANIFEST_PATH, '--index', indexPath, ...extra],
    { encoding: 'utf8' },
  );
}

/** Writes an index to a temporary file so the CLI can be exercised against it. */
function writeIndex(index) {
  const indexPath = path.join(mkdtempSync(path.join(tmpdir(), 'cotsel-evidence-')), 'index.json');
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return indexPath;
}

test('the command-line check passes for a bound pair and fails closed for a stale one', () => {
  const script = SCRIPT_PATH;
  const run = (indexPath) =>
    spawnSync(process.execPath, [script, '--manifest', MANIFEST_PATH, '--index', indexPath], {
      encoding: 'utf8',
    });

  const passed = run(INDEX_PATH);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /Evidence index valid; 2 entries bound to/);
  assert.match(passed.stdout, /2 accepted/);
  // Delivery completion is not acceptance: the plain run must say what it did not check.
  assert.match(passed.stdout, /acceptance not checked/);

  const stale = indexFixture();
  staleMutations.sourceCommit(stale.entries[0]);

  const failed = run(writeIndex(stale));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /was produced against a different sourceCommit/);
});

/**
 * The one command operators run must not report an index of entirely unreviewed entries as good.
 * Binding is checked always; acceptance only when the required control set is named.
 */
test('the command line enforces acceptance when required controls are named', () => {
  const accepted = runCli(INDEX_PATH, '--require-controls', 'REPORT-02,PROG-01');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Accepted evidence present for REPORT-02, PROG-01/);

  const pending = indexFixture();
  for (const entry of pending.entries) {
    entry.reviewer.decision = 'pending';
  }
  const pendingPath = writeIndex(pending);

  const unchecked = runCli(pendingPath);
  assert.equal(unchecked.status, 0, unchecked.stderr);
  assert.match(unchecked.stdout, /0 accepted/);

  const required = runCli(pendingPath, '--require-controls', 'REPORT-02,PROG-01');
  assert.equal(required.status, 1);
  assert.match(required.stderr, /no accepted evidence for REPORT-02, PROG-01/);
  assert.doesNotMatch(required.stdout, /Evidence index valid/);

  const missingIndex = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--manifest', MANIFEST_PATH, '--require-controls', 'REPORT-02'],
    { encoding: 'utf8' },
  );
  assert.equal(missingIndex.status, 1);
  assert.match(missingIndex.stderr, /--require-controls also requires --index/);
});

test('rebinding helper keeps a deliberately changed manifest self-consistent', () => {
  const manifest = manifestFixture();
  manifest.providerMode.signer = 'mpc';
  const index = rebind(indexFixture(), manifest);
  index.entries[0].boundIdentity.providerMode.signer = 'mpc';
  index.entries[1].boundIdentity.providerMode.signer = 'mpc';

  assert.doesNotThrow(() => validateEvidenceIndex(index, manifest, { now: NOW }));
});
