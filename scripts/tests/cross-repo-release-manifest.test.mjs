import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertManifestRunnable,
  readReleaseManifest,
  validateReleaseManifest,
  verifyCommitOnRef,
} from '../check-cross-repo-release-manifest.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'manifest-test',
      GIT_AUTHOR_EMAIL: 'manifest-test@example.invalid',
      GIT_COMMITTER_NAME: 'manifest-test',
      GIT_COMMITTER_EMAIL: 'manifest-test@example.invalid',
    },
  }).trim();
}

function commit(cwd, message) {
  git(cwd, 'commit', '--quiet', '--allow-empty', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * Builds an origin with `main` (base -> tip) and an unmerged `side` branch, the
 * shape of a PR head or squash-merged branch that never landed on `main`.
 */
function createOrigin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-manifest-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '--quiet', '--initial-branch=main');
  const base = commit(work, 'base');
  const tip = commit(work, 'tip');
  git(work, 'switch', '--quiet', '-c', 'side', base);
  const side = commit(work, 'side');
  git(work, 'switch', '--quiet', 'main');
  const origin = path.join(root, 'origin.git');
  git(root, 'clone', '--quiet', '--bare', work, origin);
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { root, origin, base, tip, side };
}

/**
 * Mirrors actions/checkout with `ref: <sha>`: a depth-1 fetch of exactly the
 * pinned commit, with no branch history and no remote-tracking branches.
 */
function shallowCheckout(fixture, sha) {
  const directory = fs.mkdtempSync(path.join(fixture.root, 'checkout-'));
  git(directory, 'init', '--quiet');
  git(directory, 'remote', 'add', 'origin', `file://${fixture.origin}`);
  git(directory, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', sha);
  git(directory, 'checkout', '--quiet', '--detach', sha);
  return directory;
}

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

test('accepts a pinned commit contained in its ref from a shallow checkout', (t) => {
  const fixture = createOrigin();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  // The pin is older than the branch tip: main has moved on since it was pinned.
  const checkout = shallowCheckout(fixture, fixture.base);

  assert.doesNotThrow(() =>
    verifyCommitOnRef(checkout, { name: 'agroasys-backend', ref: 'main', commit: fixture.base }),
  );
});

test('rejects a pinned commit that is not contained in its ref', (t) => {
  const fixture = createOrigin();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const checkout = shallowCheckout(fixture, fixture.side);

  assert.throws(
    () => verifyCommitOnRef(checkout, { name: 'Cotsel-Dash', ref: 'main', commit: fixture.side }),
    /Cotsel-Dash commit [0-9a-f]{40} is not contained in ref main/,
  );
});

test('rejects a ref that no longer exists on the remote', (t) => {
  const fixture = createOrigin();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const checkout = shallowCheckout(fixture, fixture.side);
  git(fixture.origin, 'branch', '-D', 'side');

  assert.throws(
    () => verifyCommitOnRef(checkout, { name: 'Cotsel-Dash', ref: 'side', commit: fixture.side }),
    /Cotsel-Dash ref side could not be fetched/,
  );
});
