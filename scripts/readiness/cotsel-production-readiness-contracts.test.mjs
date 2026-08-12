import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  validateGateControl,
  validateIssueRoutedControl,
  validateRouteContractShape,
  validateWorkPackageShape,
} from './cotsel-production-readiness-contract-checks.mjs';
import {
  expectedProjectFieldNames,
  expectedProjectSingleSelectOptions,
  primaryProjectMetadata,
} from './cotsel-production-readiness-project-metadata.mjs';

const routeKeys = new Set(['primary', 'contributor']);
const allowedGates = new Set(['E-0']);
const baseControl = {
  id: 'CONTROL-01',
  requiredWork: 'Preserve one explicit production control.',
  implementationRequirement:
    'Implement a specific production requirement with explicit authority, negative behavior, containment, and deterministic recovery across the deployed path.',
  acceptanceEvidence:
    'Retain immutable release-bound proof with a producing run, environment identity, failure result, reviewer, and acceptance decision for the exact candidate.',
  sourceSection: 'Section 1',
  representation: 'structured-paraphrase',
  primaryRoute: 'primary',
  contributingRoutes: ['contributor'],
};

test('issue-routed controls reject an unknown primary route', () => {
  assert.throws(
    () => validateIssueRoutedControl({ ...baseControl, primaryRoute: 'missing' }, routeKeys),
    /unknown primary route/,
  );
});

test('issue-routed controls reject duplicate contributors', () => {
  assert.throws(
    () =>
      validateIssueRoutedControl(
        { ...baseControl, contributingRoutes: ['contributor', 'contributor'] },
        routeKeys,
      ),
    /duplicate contributor/,
  );
});

test('issue-routed controls reject the primary route as a contributor', () => {
  assert.throws(
    () =>
      validateIssueRoutedControl({ ...baseControl, contributingRoutes: ['primary'] }, routeKeys),
    /primary repeated as contributor/,
  );
});

test('issue-routed controls reject old generic boilerplate', () => {
  assert.throws(
    () =>
      validateIssueRoutedControl(
        {
          ...baseControl,
          implementationRequirement:
            'Implement this control as an explicit, reviewable part of an unrelated outcome.',
        },
        routeKeys,
      ),
    /old boilerplate/,
  );
});

test('release gates reject implementation ownership and unknown evidence routes', () => {
  assert.throws(
    () =>
      validateGateControl(
        {
          id: 'E-0',
          primaryRoute: 'primary',
          application: { type: 'release-gate', gate: 'E-0' },
          evidenceRoutes: ['missing'],
        },
        routeKeys,
      ),
    /cannot have primaryRoute/,
  );
});

test('route schema rejects removed controlIds and gate fields', () => {
  assert.throws(
    () =>
      validateRouteContractShape(
        {
          key: 'primary',
          controlIds: ['CONTROL-01'],
          primaryGate: 'E-0',
          dependencies: [],
        },
        routeKeys,
        allowedGates,
      ),
    /removed controlIds/,
  );
});

test('work packages reject a missing SOW control-sheet field', () => {
  const workPackage = Object.fromEntries(
    [
      'objective',
      'inScope',
      'outOfScope',
      'owner',
      'reviewers',
      'githubAssignee',
      'githubReviewer',
      'dependencies',
      'implementation',
      'verification',
      'evidence',
      'rollback',
      'residualRisk',
      'milestone',
      'gate',
      'track',
      'risk',
    ].map((field) => [field, 'defined']),
  );
  workPackage.id = 'WP-0';
  workPackage.githubAssignee = 'czpyioe';
  workPackage.githubReviewer = 'Astton';
  workPackage.reviewers = '';
  assert.throws(() => validateWorkPackageShape(workPackage), /missing reviewers/);
});

test('Project field contract covers every primary metadata value', () => {
  assert.equal(expectedProjectFieldNames.length, 30);
  assert.equal(new Set(expectedProjectFieldNames).size, expectedProjectFieldNames.length);
  for (const fieldName of Object.keys(expectedProjectSingleSelectOptions)) {
    assert.ok(
      expectedProjectFieldNames.includes(fieldName),
      `${fieldName} exists in Project fields`,
    );
  }
  for (const [title, metadata] of primaryProjectMetadata()) {
    for (const [fieldName, options] of Object.entries(expectedProjectSingleSelectOptions)) {
      if (metadata[fieldName] === undefined) continue;
      assert.ok(
        options.includes(metadata[fieldName]),
        `${title}: ${fieldName}=${metadata[fieldName]} exists in Project options`,
      );
    }
  }
});

test('the WP-0 governance baseline publishes the initial weekly blocker register', () => {
  const governanceRegister = readFileSync(
    new URL('../../docs/readiness/cotsel-governance-register-v1.md', import.meta.url),
    'utf8',
  );
  const blockerRegister = readFileSync(
    new URL('../../docs/readiness/cotsel-weekly-blocker-register.md', import.meta.url),
    'utf8',
  );

  assert.match(governanceRegister, /cotsel-weekly-blocker-register\.md/);
  assert.match(blockerRegister, /Edition 2026-W33\.1/);
  for (const requiredField of [
    'Blocker',
    'Owner',
    'Gate and dependency',
    'Evidence and residual risk',
    'Next decision and due date',
    'Reviewer acknowledgement and escalation',
  ]) {
    assert.match(blockerRegister, new RegExp(requiredField));
  }
  for (const issueNumber of [635, 637, 638, 684, 686, 687, 690]) {
    assert.match(blockerRegister, new RegExp(`issues/${issueNumber}`));
  }
});
