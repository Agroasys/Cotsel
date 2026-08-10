import assert from 'node:assert/strict';

const prohibitedBoilerplate = [
  'Implement this control as an explicit, reviewable part of',
  'Provide release-bound evidence that proves',
];

export function validateRouteContractShape(route, routeKeys, allowedGates) {
  assert.ok(route.key?.trim(), 'route key is required');
  assert.ok(!Object.hasOwn(route, 'controlIds'), `${route.key} uses removed controlIds`);
  assert.ok(!Object.hasOwn(route, 'gate'), `${route.key} uses removed gate field`);
  assert.ok(allowedGates.has(route.primaryGate), `${route.key} has invalid primaryGate`);
  for (const dependency of route.dependencies || []) {
    assert.ok(routeKeys.has(dependency), `${route.key} has unknown dependency ${dependency}`);
  }
}

export function validateIssueRoutedControl(control, routeKeys) {
  for (const field of [
    'id',
    'requiredWork',
    'implementationRequirement',
    'acceptanceEvidence',
    'sourceSection',
    'representation',
    'primaryRoute',
  ]) {
    assert.ok(control[field]?.trim(), `${control.id || '<unknown>'} missing ${field}`);
  }
  assert.ok(routeKeys.has(control.primaryRoute), `${control.id} has unknown primary route`);
  assert.ok(Array.isArray(control.contributingRoutes), `${control.id} missing contributors array`);
  assert.equal(
    new Set(control.contributingRoutes).size,
    control.contributingRoutes.length,
    `${control.id} duplicate contributor`,
  );
  for (const route of control.contributingRoutes) {
    assert.ok(routeKeys.has(route), `${control.id} has unknown contributor ${route}`);
    assert.notEqual(route, control.primaryRoute, `${control.id} primary repeated as contributor`);
  }
  for (const phrase of prohibitedBoilerplate) {
    assert.ok(!control.implementationRequirement.includes(phrase), `${control.id} old boilerplate`);
    assert.ok(!control.acceptanceEvidence.includes(phrase), `${control.id} old boilerplate`);
  }
}

export function validateGateControl(control, routeKeys) {
  assert.equal(control.application?.type, 'release-gate', `${control.id} gate application`);
  assert.equal(control.application.gate, control.id, `${control.id} gate identity`);
  assert.ok(!control.primaryRoute, `${control.id} gate cannot have primaryRoute`);
  assert.ok(control.evidenceRoutes?.length, `${control.id} missing evidence routes`);
  assert.equal(
    new Set(control.evidenceRoutes).size,
    control.evidenceRoutes.length,
    `${control.id} duplicate evidence route`,
  );
  for (const route of control.evidenceRoutes) {
    assert.ok(routeKeys.has(route), `${control.id} has unknown evidence route ${route}`);
  }
}

export function validateWorkPackageShape(workPackage) {
  for (const field of [
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
  ]) {
    assert.ok(workPackage[field]?.trim(), `${workPackage.id || '<unknown>'} missing ${field}`);
  }
  for (const field of [
    'dependencyAcceptanceNote',
    'currentAcceptanceEvidence',
    'parentImplementationRequirement',
    'parentAcceptanceEvidence',
    'exitCriterion',
  ]) {
    if (workPackage[field] !== undefined) {
      assert.ok(workPackage[field].trim(), `${workPackage.id} empty ${field}`);
    }
  }
  assert.notEqual(
    workPackage.githubAssignee,
    workPackage.githubReviewer,
    `${workPackage.id} working lead cannot review their own delivery`,
  );
}
