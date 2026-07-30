import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertManifestRunnable,
  readReleaseManifest,
  validateReleaseManifest,
} from '../check-cross-repo-release-manifest.mjs';

test('accepts the checked-in cross-repository release manifest', () => {
  const manifest = readReleaseManifest();
  assert.equal(manifest.owner.role, 'Integration Lead');
  assert.equal(manifest.repositories.length, 3);
  assert.equal(manifest.status, 'candidate');
  assert.doesNotThrow(() => assertManifestRunnable(manifest));
});

test('rejects a moving branch name in place of a pinned commit', () => {
  const manifest = structuredClone(readReleaseManifest());
  manifest.repositories[0].commit = 'develop';

  assert.throws(() => validateReleaseManifest(manifest), /commit must be a full lowercase Git SHA/);
});

test('rejects a missing or different release owner', () => {
  const manifest = structuredClone(readReleaseManifest());
  manifest.owner.role = 'Release Committee';

  assert.throws(
    () => validateReleaseManifest(manifest),
    /single accountable owner must be Integration Lead/,
  );
});

test('rejects callback contract version drift', () => {
  const manifest = structuredClone(readReleaseManifest());
  manifest.contracts.observedAmounts = 'cotsel.settlement-observed-amounts.v2';

  assert.throws(
    () => validateReleaseManifest(manifest),
    /observed amount schema version is not pinned to v1/,
  );
});

test('permits compatibility checks only for a candidate or approved manifest', () => {
  const candidate = structuredClone(readReleaseManifest());
  assert.doesNotThrow(() => assertManifestRunnable(candidate));

  const baseline = structuredClone(candidate);
  baseline.status = 'baseline';
  assert.throws(() => assertManifestRunnable(baseline), /status baseline cannot be used/);

  const draft = structuredClone(candidate);
  draft.status = 'draft';
  draft.activationBlockers = ['commits are not pinned'];
  assert.throws(() => assertManifestRunnable(draft), /status draft cannot be used/);
});
