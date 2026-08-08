#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  controlById,
  controls,
  contributingControlsForRoute,
  coverage,
  gateControls,
  gateEvidenceControlsForRoute,
  issueRoutedControls,
  milestones,
  packages,
  primaryControlsForRoute,
  readinessRoot,
  requirements,
  routes,
  source,
  supportingIssues,
  workPackageControlSheetLabels,
  workPackageSheetControls,
} from './cotsel-production-readiness-model.mjs';
import {
  renderParentBody,
  renderProgrammeBody,
  renderRouteBody,
} from './render-cotsel-production-readiness-issue.mjs';
import {
  validateGateControl,
  validateIssueRoutedControl,
  validateRouteContractShape,
  validateWorkPackageShape,
} from './cotsel-production-readiness-contract-checks.mjs';

const unique = (values) => new Set(values);
const exact = (actual, expected, name) => assert.deepEqual(actual, expected, name);
const expectedWps = Array.from({ length: 13 }, (_, index) => `WP-${index}`);
const expectedFindings = [
  ...Array.from({ length: 19 }, (_, index) => `B-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 32 }, (_, index) => `H-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, index) => `I-${String(index + 1).padStart(2, '0')}`),
];
const expectedRouteCounts = [4, 5, 7, 4, 4, 3, 5, 4, 4, 7, 3, 3, 4];
const expectedCoverageCounts = {
  authorityBoundaries: 9,
  preservationRules: 10,
  testLayers: 9,
  goldenJourneys: 7,
  securityControls: 7,
  complianceControls: 8,
  infrastructureLayers: 8,
  failureRecovery: 19,
  engineeringGates: 6,
  pilotGates: 7,
  mainnetConditions: 6,
  governanceDecisions: 7,
  reporting: 5,
  residualDecisions: 3,
  assumptions: 4,
  exclusions: 3,
  environments: 4,
  workPackageControlSheet: 9,
  programmeInvariants: 5,
};
const oldBoilerplate = [
  'Implement this control as an explicit, reviewable part of',
  'Provide release-bound evidence that proves',
];

assert.equal(
  source.source.sha256,
  '775b07a7a44bc5798e0cfe4eb216abb11c81e248356061f4d94b779b3337c8fb',
);
assert.equal(source.source.pageCount, 38);
assert.equal(source.source.visuallyInspectedPages, 38);
assert.equal(source.findings.length, 58);
exact(
  source.findings.map((item) => item.id),
  expectedFindings,
  'finding sequence',
);
assert.equal(source.findings.filter((item) => item.priority === 'P0').length, 19);
assert.equal(source.findings.filter((item) => item.priority === 'P1').length, 32);
assert.equal(source.findings.filter((item) => item.priority === 'P2').length, 7);
for (const finding of source.findings) {
  for (const key of ['requiredWork', 'implementationRequirement', 'acceptanceEvidence']) {
    assert.ok(finding[key]?.trim(), `${finding.id} missing ${key}`);
  }
}

assert.equal(routes.schemaVersion, 'cotsel.production-readiness.issue-route.v3');
exact(routes.workingOwnership.allowedParticipants, ['Astton', 'czpyioe'], 'GitHub participants');
assert.ok(routes.workingOwnership.rule.includes('one GitHub assignee'));
assert.equal(routes.issues.length, 57);
assert.equal(unique(routes.issues.map((item) => item.key)).size, 57);
assert.equal(unique(routes.issues.map((item) => item.title)).size, 57);
assert.ok(routes.issues.every((route) => !Object.hasOwn(route, 'controlIds')));
assert.ok(routes.issues.every((route) => !Object.hasOwn(route, 'gate')));
const routedFindings = routes.issues.flatMap((item) => item.findingIds);
assert.equal(routedFindings.length, 58);
assert.equal(unique(routedFindings).size, 58);
exact([...routedFindings].sort(), [...expectedFindings].sort(), 'finding route coverage');
const sourceById = new Map(source.findings.map((item) => [item.id, item]));
for (const route of routes.issues) {
  for (const id of route.findingIds) {
    assert.equal(sourceById.get(id)?.workPackage, route.wp, `${id} routed to wrong WP`);
  }
}

exact(
  packages.workPackages.map((item) => item.id),
  expectedWps,
  'work package sequence',
);
assert.equal(packages.schemaVersion, 'cotsel.production-readiness.work-packages.v3');
const allowedGithubParticipants = new Set(routes.workingOwnership.allowedParticipants);
assert.ok(allowedGithubParticipants.has(packages.programmeOwnership.githubAssignee));
assert.ok(allowedGithubParticipants.has(packages.programmeOwnership.githubReviewer));
assert.notEqual(
  packages.programmeOwnership.githubAssignee,
  packages.programmeOwnership.githubReviewer,
  'programme working lead cannot review their own delivery',
);
for (const [index, wp] of expectedWps.entries()) {
  assert.equal(
    routes.issues.filter((item) => item.wp === wp).length,
    expectedRouteCounts[index],
    `${wp} route count`,
  );
}
const requiredWorkPackageFields = [
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
];
for (const workPackage of packages.workPackages) {
  validateWorkPackageShape(workPackage);
  assert.ok(allowedGithubParticipants.has(workPackage.githubAssignee));
  assert.ok(allowedGithubParticipants.has(workPackage.githubReviewer));
  for (const field of requiredWorkPackageFields) {
    assert.ok(workPackage[field]?.trim(), `${workPackage.id} missing ${field}`);
  }
  const body = renderParentBody(workPackage);
  const sheet = body.split('## Work-package control sheet')[1].split('## Programme metadata')[0];
  const labels = [...sheet.matchAll(/^\| ([^|]+?) \|/gm)]
    .map((match) => match[1].trim())
    .filter((label) => label !== 'Control');
  exact(labels, workPackageControlSheetLabels, `${workPackage.id} control-sheet labels`);
  assert.ok(!sheet.includes('| Primary gate |'));
  assert.ok(!sheet.includes('| Programme track |'));
}

assert.equal(coverage.schemaVersion, 'cotsel.production-readiness.supporting-coverage.v2');
assert.equal(requirements.schemaVersion, 'cotsel.production-readiness.supporting-requirements.v1');
for (const [groupName, expectedCount] of Object.entries(expectedCoverageCounts)) {
  const coverageGroup = coverage.groups[groupName];
  const requirementGroup = requirements.groups[groupName];
  assert.ok(coverageGroup, `missing coverage group ${groupName}`);
  assert.ok(requirementGroup, `missing requirement group ${groupName}`);
  assert.equal(coverageGroup.expectedCount, expectedCount, `${groupName} declared count`);
  assert.equal(coverageGroup.entries.length, expectedCount, `${groupName} coverage count`);
  assert.equal(
    Object.keys(requirementGroup.entries).length,
    expectedCount,
    `${groupName} requirement count`,
  );
  assert.ok(requirementGroup.sourceSection?.trim(), `${groupName} missing source section`);
  assert.ok(requirementGroup.sourcePages?.length, `${groupName} missing source pages`);
  assert.equal(requirementGroup.representation, 'structured-paraphrase');
}
assert.equal(controls.length, 136);
assert.equal(unique(controls.map((item) => item.id)).size, 136);
exact(
  controls.map((item) => item.id).sort(),
  Object.values(requirements.groups)
    .flatMap((group) => Object.keys(group.entries))
    .sort(),
  'coverage and requirement IDs',
);
const detailTuples = new Set();
for (const control of controls) {
  for (const field of [
    'requiredWork',
    'implementationRequirement',
    'acceptanceEvidence',
    'sourceSection',
    'representation',
  ]) {
    assert.ok(control[field]?.trim(), `${control.id} missing ${field}`);
  }
  assert.ok(control.implementationRequirement.length >= 80, `${control.id} implementation is thin`);
  assert.ok(control.acceptanceEvidence.length >= 80, `${control.id} evidence is thin`);
  for (const phrase of oldBoilerplate) {
    assert.ok(!control.implementationRequirement.includes(phrase), `${control.id} old boilerplate`);
    assert.ok(!control.acceptanceEvidence.includes(phrase), `${control.id} old boilerplate`);
  }
  const tuple = `${control.implementationRequirement}\u0000${control.acceptanceEvidence}`;
  assert.ok(!detailTuples.has(tuple), `${control.id} duplicates another rich-content tuple`);
  detailTuples.add(tuple);
}

const routeKeys = unique(routes.issues.map((item) => item.key));
for (const control of issueRoutedControls) {
  validateIssueRoutedControl(control, routeKeys);
  assert.ok(routeKeys.has(control.primaryRoute), `${control.id} has unknown primary route`);
  assert.ok(Array.isArray(control.contributingRoutes), `${control.id} missing contributors array`);
  assert.equal(
    unique(control.contributingRoutes).size,
    control.contributingRoutes.length,
    `${control.id} duplicate contributor`,
  );
  for (const route of control.contributingRoutes) {
    assert.ok(routeKeys.has(route), `${control.id} has unknown contributor ${route}`);
    assert.notEqual(route, control.primaryRoute, `${control.id} primary repeated as contributor`);
  }
}
assert.equal(issueRoutedControls.length, 114);
assert.equal(gateControls.length, 13);
assert.equal(workPackageSheetControls.length, 9);
exact(
  gateControls.map((item) => item.id),
  ['E-0', 'E-1', 'E-2', 'E-3', 'E-4', 'E-5', 'P-0', 'P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6'],
  'release gate sequence',
);
for (const gate of gateControls) {
  validateGateControl(gate, routeKeys);
  assert.equal(gate.application.type, 'release-gate');
  assert.equal(gate.application.gate, gate.id);
  assert.ok(!gate.primaryRoute, `${gate.id} must not be implementation-owned`);
  assert.ok(gate.evidenceRoutes?.length, `${gate.id} missing evidence routes`);
  for (const route of gate.evidenceRoutes) {
    assert.ok(routeKeys.has(route), `${gate.id} has unknown evidence route ${route}`);
  }
}
for (const control of workPackageSheetControls) {
  assert.equal(control.application.type, 'all-work-package-parents');
  assert.ok(!control.primaryRoute, `${control.id} must apply structurally`);
}

const expectedPrimaryRoutes = new Map([
  ['PRES-05', 'wp4-makerchecker'],
  ['PRES-06', 'wp9-service-auth'],
  ['PRES-10', 'wp6-gate'],
  ['TEST-05', 'wp8-drills'],
  ['TEST-07', 'wp7-iac'],
  ['SEC-06', 'wp8-evidence'],
  ['COMP-05', 'wp10-controls'],
  ['FAIL-12', 'wp2-durable-dispatch'],
  ['FAIL-15', 'wp1-contract-deploy'],
  ['FAIL-16', 'wp7-readiness'],
  ['REPORT-03', 'wp11-rehearsal'],
  ['REPORT-04', 'wp8-observability'],
]);
for (const [id, route] of expectedPrimaryRoutes) {
  assert.equal(controlById.get(id).primaryRoute, route, `${id} primary route`);
}
for (const route of routes.issues) {
  const primaryControls = primaryControlsForRoute(route.key);
  assert.ok(
    route.findingIds.length + primaryControls.length > 0,
    `${route.key} owns no requirement`,
  );
  const body = renderRouteBody(route);
  const primarySection = body
    .split('## Contributing evidence obligations')[0]
    .split('## Release-gate evidence obligations')[0];
  for (const control of primaryControls) {
    assert.ok(
      primarySection.includes(`| ${control.id} |`),
      `${control.id} missing from primary table for ${route.key}`,
    );
  }
  for (const control of contributingControlsForRoute(route.key)) {
    assert.ok(
      body.includes(`| ${control.id} (contributor) |`),
      `${control.id} contributor row missing from ${route.key}`,
    );
    assert.ok(
      !primarySection.includes(`| ${control.id} |`),
      `${control.id} contributor self-accepted`,
    );
  }
  for (const gate of gateEvidenceControlsForRoute(route.key)) {
    assert.ok(body.includes(`| ${gate.id} (gate evidence) |`), `${gate.id} gate evidence missing`);
  }
  for (const phrase of oldBoilerplate)
    assert.ok(!body.includes(phrase), `${route.key} boilerplate`);
}
const programmeBody = renderProgrammeBody();
for (const gate of gateControls) {
  assert.ok(
    programmeBody.includes(`| ${gate.id} |`),
    `${gate.id} missing from programme gate table`,
  );
}

const enumerations = {
  priority: ['P0', 'P1', 'P2', 'P3'],
  sowClass: ['P0 Blocker', 'P1 Prerequisite', 'P2 Improvement', 'Control', 'Decision', 'Gate'],
  workType: [
    'Decision',
    'Implementation',
    'Evidence',
    'External Dependency',
    'Defect',
    'Gate Review',
  ],
  track: ['Engineering Remediation', 'Base Sepolia Rehearsal', 'Controlled Pilot', 'Base Mainnet'],
  primaryGate: [
    'E-0',
    'E-1',
    'E-2',
    'E-3',
    'E-4',
    'E-5',
    'P-0',
    'P-1',
    'P-2',
    'P-3',
    'P-4',
    'P-5',
    'P-6',
    'Mainnet',
    'Not Applicable',
  ],
  risk: ['Critical', 'High', 'Medium', 'Low'],
  external: ['Yes', 'No'],
};
for (const route of routes.issues) {
  validateRouteContractShape(route, routeKeys, new Set(enumerations.primaryGate));
  for (const [field, allowed] of Object.entries(enumerations)) {
    assert.ok(allowed.includes(route[field]), `${route.key} has invalid ${field}: ${route[field]}`);
  }
  for (const dependency of route.dependencies) {
    assert.ok(routeKeys.has(dependency), `${route.key} has unknown dependency ${dependency}`);
  }
}

assert.equal(supportingIssues.issues.length, 15);
assert.equal(unique(supportingIssues.issues.map((item) => item.number)).size, 15);
const expectedSupporting = new Map();
for (const route of routes.issues) {
  for (const number of route.supportingIssues) {
    if (!expectedSupporting.has(number)) expectedSupporting.set(number, []);
    expectedSupporting.get(number).push(route.key);
  }
}
for (const supporting of supportingIssues.issues) {
  assert.ok(
    routeKeys.has(supporting.primaryMetadataRoute),
    `#${supporting.number} bad primary route`,
  );
  const declared = [supporting.primaryMetadataRoute, ...supporting.contributingRoutes].sort();
  exact(
    declared,
    expectedSupporting.get(supporting.number).sort(),
    `#${supporting.number} route set`,
  );
}

assert.equal(milestones.milestones.length, 10);
assert.equal(unique(milestones.milestones.map((item) => item.number)).size, 10);
assert.equal(unique(milestones.milestones.map((item) => item.title)).size, 10);
for (const milestone of milestones.milestones) {
  assert.ok(['open', 'closed'].includes(milestone.state));
  assert.ok(milestone.description.trim(), `milestone ${milestone.number} description`);
}
const milestoneTitles = unique(milestones.milestones.map((item) => item.title));
for (const workPackage of packages.workPackages) {
  assert.ok(milestoneTitles.has(workPackage.milestone), `${workPackage.id} unknown milestone`);
}
for (const route of routes.issues) {
  assert.ok(milestoneTitles.has(route.milestone), `${route.key} unknown milestone`);
}

const forms = [
  'production-readiness-implementation.yml',
  'production-readiness-decision.yml',
  'production-readiness-external-dependency.yml',
  'production-readiness-gate-review.yml',
  'production-readiness-work-package.yml',
];
for (const name of forms) {
  const text = fs.readFileSync(path.join(readinessRoot, '.github/ISSUE_TEMPLATE', name), 'utf8');
  assert.match(text, /^assignees: \[\]$/m, `${name} starts unassigned`);
  assert.ok(
    text.includes('| ID | Required work | Implementation requirement | Acceptance evidence |'),
  );
  assert.match(text, /Generic .*boilerplate is prohibited\./, `${name} boilerplate warning`);
}
const workPackageForm = fs.readFileSync(
  path.join(readinessRoot, '.github/ISSUE_TEMPLATE/production-readiness-work-package.yml'),
  'utf8',
);
for (const label of workPackageControlSheetLabels) {
  assert.ok(workPackageForm.includes(`| ${label} |`), `work-package form missing ${label}`);
}
assert.ok(!workPackageForm.match(/^\s*\| Primary gate \|/m));
assert.ok(!workPackageForm.match(/^\s*\| Programme track \|/m));

console.log('Cotsel production-readiness contracts are complete and internally consistent.');
console.log(
  JSON.stringify(
    {
      findings: 58,
      primaryIssues: 57,
      supportingControls: 136,
      issueRoutedControls: issueRoutedControls.length,
      releaseGateDefinitions: gateControls.length,
      structuralWorkPackageFields: workPackageSheetControls.length,
      workPackages: 13,
      reusedSupportingIssues: supportingIssues.issues.length,
      milestoneDefinitions: milestones.milestones.length,
    },
    null,
    2,
  ),
);
