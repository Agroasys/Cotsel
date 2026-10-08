import inventory from '../integration/release-candidate-inventory.json' with { type: 'json' };

export const requiredCheckContexts = [
  'ci/release-gate',
  'Analyze (javascript-typescript)',
  'Analyze (actions)',
  'dco/check',
  'enforce/pr-roadmap-policy',
  ...inventory.artifacts
    .filter((artifact) => artifact.sourceRepository === 'Agroasys/Cotsel' && artifact.dockerfile)
    .map((artifact) => `build/${artifact.name}`),
];
export const protectedEnvironments = [
  'staging',
  'base-sepolia-evidence',
  'base-sepolia-evidence-review',
];
export const githubActionsAppId = 15368;

function rule(snapshot, type) {
  return snapshot.ruleset?.rules?.find((entry) => entry.type === type);
}

export function evaluateGovernance(snapshot) {
  const violations = [];
  const require = (condition, message) => {
    if (!condition) violations.push(message);
  };
  require(snapshot.schemaVersion ===
    'cotsel.wp6-governance-snapshot.v1', 'snapshot schema is missing');
  require(/^[a-f0-9]{40}$/u.test(snapshot.sourceCommit ?? ''), 'source commit is missing');
  require(Number.isFinite(Date.parse(snapshot.observedAt)), 'observation time is missing');
  require(snapshot.ruleset?.enforcement === 'active', 'main ruleset must be active');
  require(snapshot.ruleset?.target === 'branch', 'main ruleset must target branches');
  const refs = snapshot.ruleset?.conditions?.ref_name;
  require(refs?.include?.includes('refs/heads/main') ||
    refs?.include?.includes('~DEFAULT_BRANCH'), 'main must be included in the ruleset');
  require(Array.isArray(refs?.exclude) &&
    refs.exclude.length === 0, 'main must not have exclusions');
  require(Array.isArray(snapshot.ruleset?.bypass_actors) &&
    snapshot.ruleset.bypass_actors.length ===
      0, 'standing administrator and app bypasses are prohibited');
  for (const type of ['deletion', 'non_fast_forward', 'required_linear_history']) {
    require(Boolean(rule(snapshot, type)), `missing ${type} protection`);
  }
  const review = rule(snapshot, 'pull_request')?.parameters;
  for (const key of [
    'require_code_owner_review',
    'dismiss_stale_reviews_on_push',
    'require_last_push_approval',
    'required_review_thread_resolution',
  ]) {
    require(review?.[key] === true, `${key} must be enabled`);
  }
  require(review?.required_approving_review_count >= 1, 'independent approval must be required');
  const checks = rule(snapshot, 'required_status_checks')?.parameters;
  require(checks?.strict_required_status_checks_policy === true, 'strict checks must be enabled');
  for (const context of requiredCheckContexts) {
    require(checks?.required_status_checks?.some(
      (check) => check.context === context && check.integration_id === githubActionsAppId,
    ), `${context} must be required from GitHub Actions`);
  }
  require(snapshot.workflowPermissions?.default_workflow_permissions ===
    'read', 'workflow defaults must be read-only');
  require(snapshot.workflowPermissions?.can_approve_pull_request_reviews ===
    false, 'workflow PR approvals must be disabled');
  require(snapshot.actionsPermissions?.enabled === true, 'Actions must remain enabled');
  require(snapshot.actionsPermissions?.sha_pinning_required ===
    true, 'Actions SHA pinning must be required');
  for (const name of protectedEnvironments) {
    const environment = snapshot.environments?.[name];
    const reviewers = environment?.protection_rules?.find(
      (entry) => entry.type === 'required_reviewers',
    );
    require(environment?.can_admins_bypass ===
      false, `${name}: administrator bypass must be disabled`);
    require(reviewers?.prevent_self_review === true, `${name}: self-review must be disabled`);
    require(reviewers?.reviewers?.length > 0, `${name}: independent reviewers must be configured`);
    require(environment?.deployment_branch_policy?.custom_branch_policies === true &&
      environment.deployment_branch_policy.protected_branches ===
        false, `${name}: explicit branch policy is required`);
    const policies = snapshot.branchPolicies?.[name]?.branch_policies;
    require(Array.isArray(policies) &&
      policies.length === 1 &&
      policies[0].name === 'main' &&
      policies[0].type === 'branch', `${name}: only the main branch may deploy`);
  }
  require(snapshot.securityAndAnalysis?.secret_scanning?.status ===
    'enabled', 'secret scanning must be enabled');
  require(snapshot.securityAndAnalysis?.secret_scanning_push_protection?.status ===
    'enabled', 'push protection must be enabled');
  return { passed: violations.length === 0, violations };
}

export function proposeGovernance(snapshot) {
  const ruleset = structuredClone(snapshot.ruleset);
  if (!ruleset?.rules || !ruleset.conditions)
    throw new Error('complete ruleset snapshot is required');
  const upsert = (type, parameters) => {
    const current = ruleset.rules.find((entry) => entry.type === type);
    if (current && parameters) current.parameters = { ...current.parameters, ...parameters };
    else if (!current) ruleset.rules.push(parameters ? { type, parameters } : { type });
  };
  ruleset.enforcement = 'active';
  ruleset.bypass_actors = [];
  ruleset.conditions.ref_name = { include: ['refs/heads/main'], exclude: [] };
  for (const type of ['deletion', 'non_fast_forward', 'required_linear_history']) upsert(type);
  upsert('pull_request', {
    require_code_owner_review: true,
    dismiss_stale_reviews_on_push: true,
    require_last_push_approval: true,
    required_review_thread_resolution: true,
    required_approving_review_count: Math.max(
      1,
      rule(snapshot, 'pull_request')?.parameters?.required_approving_review_count ?? 1,
    ),
  });
  const existingChecks =
    rule(snapshot, 'required_status_checks')?.parameters?.required_status_checks ?? [];
  upsert('required_status_checks', {
    strict_required_status_checks_policy: true,
    required_status_checks: [
      ...existingChecks.filter((check) => !requiredCheckContexts.includes(check.context)),
      ...requiredCheckContexts.map((context) => ({ context, integration_id: githubActionsAppId })),
    ],
  });
  const environments = {};
  for (const name of protectedEnvironments) {
    const before = snapshot.environments?.[name];
    const reviewers = before?.protection_rules?.find(
      (entry) => entry.type === 'required_reviewers',
    );
    if (!reviewers?.reviewers?.length) throw new Error(`${name}: reviewer identities are required`);
    environments[name] = {
      wait_timer:
        before.protection_rules?.find((entry) => entry.type === 'wait_timer')?.wait_timer ?? 0,
      prevent_self_review: true,
      can_admins_bypass: false,
      reviewers: reviewers.reviewers.map((entry) => ({ type: entry.type, id: entry.reviewer.id })),
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    };
  }
  const { name, target, enforcement, conditions, rules, bypass_actors } = ruleset;
  return {
    ruleset: { name, target, enforcement, conditions, rules, bypass_actors },
    workflowPermissions: {
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: false,
    },
    actionsPermissions: {
      ...snapshot.actionsPermissions,
      enabled: true,
      sha_pinning_required: true,
    },
    environments,
    branchPolicies: Object.fromEntries(
      protectedEnvironments.map((environment) => [environment, { name: 'main', type: 'branch' }]),
    ),
  };
}
