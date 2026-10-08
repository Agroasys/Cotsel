import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateGovernance,
  proposeGovernance,
  requiredCheckContexts,
  protectedEnvironments,
  githubActionsAppId,
} from '../wp6-governance-policy.mjs';

function compliant() {
  return {
    schemaVersion: 'cotsel.wp6-governance-snapshot.v1',
    sourceCommit: 'a'.repeat(40),
    observedAt: '2026-10-08T00:00:00Z',
    ruleset: {
      name: 'main',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [
        ...['deletion', 'non_fast_forward', 'required_linear_history'].map((type) => ({ type })),
        {
          type: 'pull_request',
          parameters: {
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: true,
            require_last_push_approval: true,
            required_review_thread_resolution: true,
            required_approving_review_count: 1,
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: requiredCheckContexts.map((context) => ({
              context,
              integration_id: githubActionsAppId,
            })),
          },
        },
      ],
    },
    workflowPermissions: {
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: false,
    },
    actionsPermissions: { enabled: true, allowed_actions: 'all', sha_pinning_required: true },
    securityAndAnalysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
    environments: Object.fromEntries(
      protectedEnvironments.map((name) => [
        name,
        {
          can_admins_bypass: false,
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          protection_rules: [
            {
              type: 'required_reviewers',
              prevent_self_review: true,
              reviewers: [{ type: 'User', reviewer: { id: 1, login: 'independent-reviewer' } }],
            },
          ],
        },
      ]),
    ),
    branchPolicies: Object.fromEntries(
      protectedEnvironments.map((name) => [
        name,
        {
          branch_policies: [{ name: 'main', type: 'branch' }],
        },
      ]),
    ),
  };
}

test('accepts the complete governance policy and derives all nine image contexts', () => {
  assert.equal(evaluateGovernance(compliant()).passed, true);
  assert.equal(requiredCheckContexts.filter((context) => context.startsWith('build/')).length, 9);
});

test('rejects every missing check and spoofable check producer', () => {
  for (const context of requiredCheckContexts) {
    for (const integrationId of [null, 999]) {
      const snapshot = compliant();
      const checks = snapshot.ruleset.rules.find(
        (entry) => entry.type === 'required_status_checks',
      ).parameters;
      checks.required_status_checks.find((check) => check.context === context).integration_id =
        integrationId;
      assert.equal(evaluateGovernance(snapshot).passed, false, context);
    }
    const snapshot = compliant();
    const checks = snapshot.ruleset.rules.find(
      (entry) => entry.type === 'required_status_checks',
    ).parameters;
    checks.required_status_checks = checks.required_status_checks.filter(
      (check) => check.context !== context,
    );
    assert.equal(evaluateGovernance(snapshot).passed, false, context);
  }
});

test('rejects standing bypass, weakened review, workflow privilege, and push-protection gaps', () => {
  const mutations = [
    (s) => {
      s.ruleset.bypass_actors.push({ actor_type: 'OrganizationAdmin', bypass_mode: 'always' });
    },
    (s) => {
      s.ruleset.conditions.ref_name.exclude.push('refs/heads/main');
    },
    (s) => {
      s.ruleset.rules.find((r) => r.type === 'pull_request').parameters.require_code_owner_review =
        false;
    },
    (s) => {
      s.workflowPermissions.default_workflow_permissions = 'write';
    },
    (s) => {
      s.workflowPermissions.can_approve_pull_request_reviews = true;
    },
    (s) => {
      s.actionsPermissions.sha_pinning_required = false;
    },
    (s) => {
      s.securityAndAnalysis.secret_scanning_push_protection.status = 'disabled';
    },
  ];
  for (const mutate of mutations) {
    const snapshot = compliant();
    mutate(snapshot);
    assert.equal(evaluateGovernance(snapshot).passed, false);
  }
});

test('rejects bypass, missing reviewers, self-review, wildcard or tag deployments in every environment', () => {
  for (const name of protectedEnvironments) {
    for (const mutate of [
      (s) => {
        s.environments[name].can_admins_bypass = true;
      },
      (s) => {
        s.environments[name].protection_rules[0].prevent_self_review = false;
      },
      (s) => {
        s.environments[name].protection_rules[0].reviewers = [];
      },
      (s) => {
        s.branchPolicies[name].branch_policies[0].name = '*';
      },
      (s) => {
        s.branchPolicies[name].branch_policies[0].type = 'tag';
      },
    ]) {
      const snapshot = compliant();
      mutate(snapshot);
      assert.equal(evaluateGovernance(snapshot).passed, false, name);
    }
  }
});

test('proposal preserves existing stronger checks, reviewers, timers and non-target rules without mutating its input', () => {
  const snapshot = compliant();
  snapshot.ruleset.bypass_actors.push({ actor_type: 'OrganizationAdmin', bypass_mode: 'always' });
  snapshot.ruleset.rules.push({ type: 'creation' });
  snapshot.ruleset.rules.find(
    (r) => r.type === 'pull_request',
  ).parameters.required_approving_review_count = 2;
  snapshot.ruleset.rules
    .find((r) => r.type === 'required_status_checks')
    .parameters.required_status_checks.push({ context: 'extra', integration_id: 1 });
  snapshot.environments.staging.protection_rules.push({ type: 'wait_timer', wait_timer: 10 });
  const before = structuredClone(snapshot);
  const proposal = proposeGovernance(snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(proposal.ruleset.bypass_actors, []);
  assert.equal(
    proposal.ruleset.rules.find((r) => r.type === 'pull_request').parameters
      .required_approving_review_count,
    2,
  );
  assert.ok(proposal.ruleset.rules.some((r) => r.type === 'creation'));
  assert.ok(
    proposal.ruleset.rules
      .find((r) => r.type === 'required_status_checks')
      .parameters.required_status_checks.some((c) => c.context === 'extra'),
  );
  assert.equal(proposal.environments.staging.wait_timer, 10);
  assert.deepEqual(proposal.environments.staging.reviewers, [{ type: 'User', id: 1 }]);
});

test('refuses a proposal with absent reviewer identities', () => {
  const snapshot = compliant();
  delete snapshot.environments.staging;
  assert.throws(() => proposeGovernance(snapshot), /reviewer identities/);
});
