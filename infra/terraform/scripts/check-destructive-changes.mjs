#!/usr/bin/env node

const PROTECTED_TYPES = new Set([
  'aws_cloudwatch_log_group',
  'aws_ecr_lifecycle_policy',
  'aws_ecr_repository',
  'aws_ecs_cluster',
  'aws_ecs_cluster_capacity_providers',
  'aws_kms_alias',
  'aws_kms_key',
  'aws_lb',
  'aws_lb_listener',
  'aws_lb_target_group',
  'aws_secretsmanager_secret',
  'aws_security_group',
]);
// Remove this one-time exemption after the reviewed gateway retirement is applied.
const REVIEWED_STATE_ONLY_REMOVALS = new Map([
  ['aws_ecs_task_definition.gateway', 'aws_ecs_task_definition'],
]);

function classify(change) {
  const actions = change.change?.actions ?? [];
  if (actions.length === 1) {
    if (['forget', 'delete', 'create', 'update', 'no-op'].includes(actions[0])) {
      return actions[0];
    }
    if (actions[0] === 'read') return 'no-op';
  }
  if (actions.length === 2 && actions.includes('delete') && actions.includes('create')) {
    return 'replace';
  }
  return 'invalid';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readStdin();
if (!raw.trim()) {
  console.error('No plan JSON on stdin.');
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(raw);
} catch (error) {
  console.error(`Plan JSON did not parse: ${error.message}`);
  process.exit(2);
}

const changes = (plan.resource_changes ?? []).map((change) => ({
  address: change.address,
  type: change.type,
  action: classify(change),
  beforeSkipDestroy: change.change?.before?.skip_destroy,
  afterSkipDestroy: change.change?.after?.skip_destroy,
}));
const destructive = changes.filter((change) => ['delete', 'replace'].includes(change.action));
const forgotten = changes.filter((change) => change.action === 'forget');
const invalid = changes.filter((change) => change.action === 'invalid');
const blocked = destructive.filter(
  (change) =>
    PROTECTED_TYPES.has(change.type) ||
    (change.type === 'aws_ecs_task_definition' &&
      (change.action === 'delete' ||
        change.beforeSkipDestroy !== true ||
        change.afterSkipDestroy !== true)),
);
const unreviewedStateRemovals = forgotten.filter(
  (change) => REVIEWED_STATE_ONLY_REMOVALS.get(change.address) !== change.type,
);

if (destructive.length > 0 || forgotten.length > 0 || invalid.length > 0) {
  console.log('Destructive, state-only removal, or invalid changes in this plan:');
  for (const change of [...destructive, ...forgotten, ...invalid]) {
    console.log(
      `  ${blocked.includes(change) || unreviewedStateRemovals.includes(change) || invalid.includes(change) ? 'BLOCKED' : 'review'}  ${change.action}  ${change.address}`,
    );
  }
}

if (blocked.length > 0 || unreviewedStateRemovals.length > 0 || invalid.length > 0) {
  console.error(
    `\n${blocked.length} unsafe destroy/replacement(s), ${unreviewedStateRemovals.length} unreviewed state-only removal(s), and ${invalid.length} invalid action set(s).`,
  );
  process.exit(1);
}

console.log('Destructive-change policy passed.');
