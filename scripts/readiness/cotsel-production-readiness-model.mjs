import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const readinessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readReadinessJson(name) {
  return JSON.parse(fs.readFileSync(path.join(readinessRoot, 'docs/readiness', name), 'utf8'));
}

export const source = readReadinessJson('cotsel-production-readiness-sow-source.json');
export const routes = readReadinessJson('cotsel-production-readiness-issue-route-contract.json');
export const coverage = readReadinessJson(
  'cotsel-production-readiness-supporting-coverage-contract.json',
);
export const requirements = readReadinessJson(
  'cotsel-production-readiness-supporting-requirements.json',
);
export const packages = readReadinessJson('cotsel-production-readiness-work-packages.json');
export const milestones = readReadinessJson('cotsel-production-readiness-milestones.json');
export const supportingIssues = readReadinessJson(
  'cotsel-production-readiness-supporting-issues.json',
);

export const findingById = new Map(source.findings.map((item) => [item.id, item]));
export const routeByKey = new Map(routes.issues.map((item) => [item.key, item]));
export const packageById = new Map(packages.workPackages.map((item) => [item.id, item]));

const requirementGroupByControlId = new Map();
for (const [groupName, group] of Object.entries(requirements.groups)) {
  for (const [id, detail] of Object.entries(group.entries)) {
    requirementGroupByControlId.set(id, {
      ...detail,
      groupName,
      sourceSection: group.sourceSection,
      sourcePages: group.sourcePages,
      representation: group.representation,
    });
  }
}

export const controls = Object.entries(coverage.groups).flatMap(([groupName, group]) =>
  group.entries.map((control) => ({
    ...control,
    groupName,
    requiredWork: control.name,
    ...requirementGroupByControlId.get(control.id),
  })),
);

export const controlById = new Map(controls.map((item) => [item.id, item]));

export const issueRoutedControls = controls.filter((item) => item.primaryRoute);
export const gateControls = controls.filter((item) => item.application?.type === 'release-gate');
export const workPackageSheetControls = controls.filter(
  (item) => item.application?.type === 'all-work-package-parents',
);

export function primaryControlsForRoute(routeKey) {
  return issueRoutedControls.filter((item) => item.primaryRoute === routeKey);
}

export function contributingControlsForRoute(routeKey) {
  return issueRoutedControls.filter((item) => (item.contributingRoutes || []).includes(routeKey));
}

export function gateEvidenceControlsForRoute(routeKey) {
  return gateControls.filter((item) => (item.evidenceRoutes || []).includes(routeKey));
}

export function sowIdsForRoute(route) {
  return [...route.findingIds, ...primaryControlsForRoute(route.key).map((item) => item.id)];
}

export function titleForWorkPackage(workPackage) {
  return `[${workPackage.id}] ${workPackage.title}`;
}

export const programmeTitle =
  '[Programme] Cotsel production readiness and controlled-pilot authorization';

export const workPackageControlSheetLabels = [
  'Objective',
  'In scope / out of scope',
  'Owner / reviewers',
  'Dependencies',
  'Implementation',
  'Verification',
  'Acceptance evidence',
  'Rollback / containment',
  'Residual risk',
];
