#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'docs/readiness', name), 'utf8'));
const source = read('cotsel-production-readiness-sow-source.json');
const routes = read('cotsel-production-readiness-issue-route-contract.json');
const coverage = read('cotsel-production-readiness-supporting-coverage-contract.json');
const packages = read('cotsel-production-readiness-work-packages.json');

const unique = (values) => new Set(values);
const exact = (actual, expected, name) => assert.deepEqual(actual, expected, name);
const expectedWps = Array.from({ length: 13 }, (_, index) => `WP-${index}`);
const expectedFindings = [
  ...Array.from({ length: 19 }, (_, index) => `B-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 32 }, (_, index) => `H-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, index) => `I-${String(index + 1).padStart(2, '0')}`),
];
const expectedRouteCounts = [4, 5, 7, 4, 4, 3, 5, 4, 4, 6, 3, 3, 4];
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
};

assert.equal(
  source.source.sha256,
  '775b07a7a44bc5798e0cfe4eb216abb11c81e248356061f4d94b779b3337c8fb',
);
assert.equal(source.source.pageCount, 38);
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

assert.equal(routes.issues.length, 56);
assert.equal(unique(routes.issues.map((item) => item.key)).size, 56);
assert.equal(unique(routes.issues.map((item) => item.title)).size, 56);
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
assert.equal(packages.workPackages.length, 13);
for (const [index, wp] of expectedWps.entries()) {
  assert.equal(
    routes.issues.filter((item) => item.wp === wp).length,
    expectedRouteCounts[index],
    `${wp} route count`,
  );
}

const coverageEntries = Object.entries(coverage.groups).flatMap(([groupName, group]) => {
  assert.equal(
    group.expectedCount,
    expectedCoverageCounts[groupName],
    `${groupName} declared count`,
  );
  assert.equal(
    group.entries.length,
    expectedCoverageCounts[groupName],
    `${groupName} actual count`,
  );
  return group.entries;
});
assert.equal(coverageEntries.length, 131);
assert.equal(unique(coverageEntries.map((item) => item.id)).size, 131);
const routeKeys = unique(routes.issues.map((item) => item.key));
const coverageIds = unique(coverageEntries.map((item) => item.id));
for (const control of coverageEntries)
  assert.ok(routeKeys.has(control.primaryRoute), `${control.id} has unknown primary route`);
for (const route of routes.issues) {
  for (const id of route.controlIds)
    assert.ok(coverageIds.has(id), `${route.key} has unknown control ${id}`);
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
  gate: [
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
  for (const [field, allowed] of Object.entries(enumerations)) {
    assert.ok(allowed.includes(route[field]), `${route.key} has invalid ${field}: ${route[field]}`);
  }
  for (const dependency of route.dependencies)
    assert.ok(routeKeys.has(dependency), `${route.key} has unknown dependency ${dependency}`);
}

console.log('Cotsel production-readiness contracts are complete and internally consistent.');
console.log(
  JSON.stringify(
    { findings: 58, primaryIssues: 56, supportingControls: 131, workPackages: 13 },
    null,
    2,
  ),
);
