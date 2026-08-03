import {
  packages,
  programmeTitle,
  routeByKey,
  routes,
  sowIdsForRoute,
  supportingIssues,
  titleForWorkPackage,
} from './cotsel-production-readiness-model.mjs';

const externallyDependentWps = new Set(['WP-0', 'WP-7', 'WP-9', 'WP-10', 'WP-11', 'WP-12']);

export const invariantProjectFields = [
  'Programme Track',
  'Primary Gate',
  'SOW Class',
  'SOW ID',
  'Priority',
  'Work Type',
  'Delivery Surface',
  'Accountable Owner',
  'Delivery Owner',
  'Acceptance Owner',
  'External Dependency',
  'Risk',
];

export const mutableProjectFields = [
  'Status',
  'Evidence Status',
  'Target Release ID',
  'Blocked Reason',
  'Target Date',
];

export function primaryProjectMetadata() {
  const metadata = new Map();
  metadata.set(programmeTitle, {
    Status: 'Backlog',
    'Programme Track': 'Engineering Remediation',
    'Primary Gate': 'E-0',
    Priority: 'P0',
    'Work Type': 'Programme',
    'Delivery Surface': 'Programme/Governance',
    'SOW Class': 'Control',
    'SOW ID': 'Programme; 58 findings; 136 supporting controls',
    'Accountable Owner': 'Programme Lead',
    'Delivery Owner': 'Cotsel engineering leads',
    'Acceptance Owner': 'Engineering, Product, Finance, Operations, and launch authorities',
    'External Dependency': 'Yes',
    Risk: 'Critical',
    'Evidence Status': 'None',
  });

  for (const workPackage of packages.workPackages) {
    metadata.set(titleForWorkPackage(workPackage), {
      Status: 'Backlog',
      'Work Package': workPackage.id,
      'Programme Track': workPackage.track,
      'Primary Gate': workPackage.gate,
      Priority: 'P0',
      'Work Type': 'Work Package',
      'Delivery Surface': 'Programme/Governance',
      'SOW Class': 'Control',
      'SOW ID': workPackage.id,
      'Accountable Owner': workPackage.owner,
      'Delivery Owner': 'Cotsel engineering and named delivery owners',
      'Acceptance Owner': workPackage.reviewers,
      'External Dependency': externallyDependentWps.has(workPackage.id) ? 'Yes' : 'No',
      Risk: workPackage.risk,
      'Evidence Status': 'None',
    });
  }

  for (const route of routes.issues) {
    metadata.set(route.title, {
      Status:
        route.workType === 'Decision'
          ? 'Decision Required'
          : route.workType === 'Gate Review'
            ? 'Evidence Review'
            : 'Backlog',
      'Work Package': route.wp,
      'Programme Track': route.track,
      'Primary Gate': route.primaryGate,
      Priority: route.priority,
      'Work Type': route.workType,
      'Delivery Surface': route.surface,
      'SOW Class': route.sowClass,
      'SOW ID': sowIdsForRoute(route).join(', '),
      'Accountable Owner': route.accountable,
      'Delivery Owner': route.delivery,
      'Acceptance Owner': route.acceptance,
      'External Dependency': route.external,
      Risk: route.risk,
      'Evidence Status': 'None',
    });
  }
  return metadata;
}

export function supportingProjectMetadata(issueByNumber) {
  const metadata = new Map();
  for (const supporting of supportingIssues.issues) {
    const issue = issueByNumber.get(supporting.number);
    if (!issue) throw new Error(`Supporting issue #${supporting.number} is missing.`);
    const route = routeByKey.get(supporting.primaryMetadataRoute);
    const labels = new Set(
      (issue.labels?.nodes || issue.labels || []).map((label) =>
        typeof label === 'string' ? label.toLowerCase() : label.name.toLowerCase(),
      ),
    );
    const state = issue.state.toUpperCase();
    const status =
      state === 'CLOSED'
        ? 'In Review'
        : labels.has('status:blocked')
          ? 'Blocked'
          : labels.has('status:in-progress')
            ? 'In Progress'
            : 'Backlog';
    metadata.set(issue.title, {
      Status: status,
      'Work Package': route.wp,
      'Programme Track': route.track,
      'Primary Gate': route.primaryGate,
      Priority: route.priority,
      'Work Type': 'Implementation',
      'Delivery Surface': route.surface,
      'SOW Class': route.sowClass,
      'SOW ID': `Supporting issue #${supporting.number}; primary metadata route ${route.key}`,
      'Accountable Owner': route.accountable,
      'Delivery Owner': route.delivery,
      'Acceptance Owner': route.acceptance,
      'External Dependency': route.external,
      Risk: route.risk,
      'Evidence Status': state === 'CLOSED' ? 'Partial' : 'None',
    });
  }
  return metadata;
}
