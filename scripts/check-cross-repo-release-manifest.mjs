#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_MANIFEST = path.join(ROOT_DIR, 'integration/release-manifest.json');
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXPECTED_REPOSITORIES = new Map([
  ['agroasys-backend', 'Agroasys/agroasys-backend'],
  ['platform.v1', 'Agroasys/platform.v1'],
  ['Cotsel-Dash', 'Agroasys/Cotsel.dash'],
]);

function fail(message) {
  throw new Error(`Release manifest invalid: ${message}`);
}

export function validateReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('root must be an object');
  }
  if (manifest.schemaVersion !== 'cotsel.release-manifest.v1') {
    fail('schemaVersion must be cotsel.release-manifest.v1');
  }
  if (!['draft', 'baseline', 'candidate', 'approved'].includes(manifest.status)) {
    fail('status must be draft, baseline, candidate or approved');
  }
  if (
    manifest.status === 'draft' &&
    (!Array.isArray(manifest.activationBlockers) ||
      manifest.activationBlockers.length === 0 ||
      manifest.activationBlockers.some(
        (blocker) => typeof blocker !== 'string' || blocker.trim().length === 0,
      ))
  ) {
    fail('draft status requires at least one activation blocker');
  }
  if (manifest.owner?.role !== 'Integration Lead') {
    fail('the single accountable owner must be Integration Lead');
  }
  if (manifest.cotselCommitSource !== 'workflow_sha') {
    fail('Cotsel commit identity must come from the workflow SHA');
  }
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length !== 3) {
    fail('exactly three pinned sibling repositories are required');
  }

  const seen = new Set();
  for (const entry of manifest.repositories) {
    const expectedRepository = EXPECTED_REPOSITORIES.get(entry?.name);
    if (!expectedRepository || entry.repository !== expectedRepository) {
      fail(`unexpected repository entry ${entry?.name ?? '<missing>'}`);
    }
    if (seen.has(entry.name)) {
      fail(`duplicate repository entry ${entry.name}`);
    }
    seen.add(entry.name);
    if (typeof entry.ref !== 'string' || entry.ref.length === 0) {
      fail(`${entry.name} ref is required`);
    }
    if (!SHA_PATTERN.test(entry.commit)) {
      fail(`${entry.name} commit must be a full lowercase Git SHA`);
    }
  }

  for (const name of EXPECTED_REPOSITORIES.keys()) {
    if (!seen.has(name)) {
      fail(`missing repository entry ${name}`);
    }
  }
  if (manifest.contracts?.settlementCallback !== 'cotsel.settlement-callback.v1') {
    fail('settlement callback contract version is not pinned to v1');
  }
  if (manifest.contracts?.observedAmounts !== 'cotsel.settlement-observed-amounts.v1') {
    fail('observed amount schema version is not pinned to v1');
  }

  return manifest;
}

export function assertManifestRunnable(manifest) {
  if (!['candidate', 'approved'].includes(manifest.status)) {
    fail(`status ${manifest.status} cannot be used for compatibility or promotion`);
  }
}

export function readReleaseManifest(manifestPath = DEFAULT_MANIFEST) {
  return validateReleaseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
}

function repositoryDirectory(name) {
  const directories = {
    'agroasys-backend': process.env.AGROASYS_BACKEND_REPO_DIR,
    'platform.v1': process.env.PLATFORM_V1_REPO_DIR,
    'Cotsel-Dash': process.env.COTSEL_DASH_REPO_DIR,
  };
  return directories[name];
}

function readHead(directory) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
}

function readWorkingTreeStatus(directory) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function verifyPinnedCheckouts(manifest) {
  for (const entry of manifest.repositories) {
    const directory = repositoryDirectory(entry.name);
    if (!directory) {
      fail(`checkout directory is not configured for ${entry.name}`);
    }
    if (readWorkingTreeStatus(directory)) {
      fail(`${entry.name} checkout contains uncommitted changes`);
    }
    const actual = readHead(directory);
    if (actual !== entry.commit) {
      fail(`${entry.name} checkout is ${actual}, expected ${entry.commit}`);
    }
  }

  const providerFixture = JSON.parse(
    fs.readFileSync(
      path.join(ROOT_DIR, 'docs/api/fixtures/cotsel-settlement-callback.v1.json'),
      'utf8',
    ),
  );
  const backendDirectory = repositoryDirectory('agroasys-backend');
  const consumerFixture = JSON.parse(
    fs.readFileSync(
      path.join(backendDirectory, 'src/contracts/fixtures/cotsel-settlement-callback.v1.json'),
      'utf8',
    ),
  );
  if (canonicalJson(providerFixture) !== canonicalJson(consumerFixture)) {
    fail('Cotsel provider fixture and Agroasys consumer fixture differ');
  }
}

function writeGithubOutputs(manifest) {
  if (!process.env.GITHUB_OUTPUT) {
    fail('GITHUB_OUTPUT is not available');
  }
  const byName = Object.fromEntries(manifest.repositories.map((entry) => [entry.name, entry]));
  const outputs = [
    `backend_commit=${byName['agroasys-backend'].commit}`,
    `platform_commit=${byName['platform.v1'].commit}`,
    `dashboard_commit=${byName['Cotsel-Dash'].commit}`,
  ];
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const manifestFlag = args.indexOf('--manifest');
  const manifestPath =
    manifestFlag >= 0 ? path.resolve(args[manifestFlag + 1] ?? '') : DEFAULT_MANIFEST;
  const manifest = readReleaseManifest(manifestPath);

  if (args.includes('--verify-checkouts')) {
    assertManifestRunnable(manifest);
    verifyPinnedCheckouts(manifest);
  }
  if (args.includes('--github-outputs')) {
    assertManifestRunnable(manifest);
    writeGithubOutputs(manifest);
  }

  process.stdout.write(
    `Release manifest valid (${manifest.status}); owner=${manifest.owner.role}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
