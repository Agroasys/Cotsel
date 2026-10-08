import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateGovernance,
  proposeGovernance,
  protectedEnvironments,
} from './wp6-governance-policy.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`${flag} requires a value`);
  return args[index + 1];
};
const output = value('--out');
if (!output) throw new Error('--out is required');
const input = value('--snapshot');
const api = (endpoint) =>
  JSON.parse(
    execFileSync('gh', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  );
let snapshot;
if (input) snapshot = JSON.parse(fs.readFileSync(input, 'utf8'));
else {
  const root = 'repos/Agroasys/Cotsel';
  const repository = api(root);
  const rulesets = api(`${root}/rulesets`);
  const main = rulesets.filter(
    (entry) => entry.name === 'main' && entry.source === 'Agroasys/Cotsel',
  );
  if (main.length !== 1) throw new Error('exactly one repository-owned main ruleset is required');
  snapshot = {
    schemaVersion: 'cotsel.wp6-governance-snapshot.v1',
    observedAt: new Date().toISOString(),
    sourceCommit: api(`${root}/commits/main`).sha,
    ruleset: api(`${root}/rulesets/${main[0].id}`),
    workflowPermissions: api(`${root}/actions/permissions/workflow`),
    actionsPermissions: api(`${root}/actions/permissions`),
    securityAndAnalysis: repository.security_and_analysis,
    environments: {},
    branchPolicies: {},
  };
  for (const environment of protectedEnvironments) {
    snapshot.environments[environment] = api(`${root}/environments/${environment}`);
    snapshot.branchPolicies[environment] = snapshot.environments[environment]
      .deployment_branch_policy?.custom_branch_policies
      ? api(`${root}/environments/${environment}/deployment-branch-policies`)
      : { branch_policies: [] };
  }
}
const evaluation = evaluateGovernance(snapshot);
const proposal = proposeGovernance(snapshot);
const proposalJson = JSON.stringify(proposal);
const packet = {
  snapshot,
  evaluation,
  proposal,
  proposalSha256: createHash('sha256').update(proposalJson).digest('hex'),
  classification: 'READ_ONLY_SETTINGS_PROPOSAL_NOT_ACCEPTANCE',
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 });
console.log(
  `Governance snapshot ${evaluation.passed ? 'passes' : 'has gaps'}: ${evaluation.violations.length} violations.`,
);
console.log(`Settings proposal SHA-256: ${packet.proposalSha256}`);
if (args.includes('--require-compliant') && !evaluation.passed) process.exitCode = 1;
