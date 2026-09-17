#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IDENTITY_DIMENSIONS,
  assertCandidateBindable,
  candidateIdentity,
  candidateIdentityDigest,
  validateCandidateManifest,
} from './lib/release-candidate-manifest.mjs';
import { assertCrossRepositoryManifestBinding } from './lib/release-candidate-inventory.mjs';
import {
  assertEvidenceIndexComplete,
  validateEvidenceIndex,
} from './lib/release-evidence-index.mjs';
import {
  CONTROL_ID_PATTERN,
  canonicalDigest,
  canonicalize,
} from './lib/release-evidence-validation.mjs';
import { validateAuthorityProfileRegistry } from './lib/release-authority-profile.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');

export {
  IDENTITY_DIMENSIONS,
  assertCandidateBindable,
  assertCrossRepositoryManifestBinding,
  assertEvidenceIndexComplete,
  candidateIdentity,
  candidateIdentityDigest,
  canonicalDigest,
  canonicalize,
  validateAuthorityProfileRegistry,
  validateCandidateManifest,
  validateEvidenceIndex,
};

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
  process.stdout.write(
    `Candidate manifest valid (${manifest.status}); candidate=${manifest.candidateId} identity=${candidateIdentityDigest(manifest)}\n`,
  );

  if (!indexPath) {
    return;
  }
  const index = validateEvidenceIndex(readJsonDocument(indexPath), manifest);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
