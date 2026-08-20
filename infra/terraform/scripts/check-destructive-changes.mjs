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

function classify(change) {
  const actions = change.change?.actions ?? [];
  if (actions.includes('delete') && actions.includes('create')) return 'replace';
  if (actions.includes('delete')) return 'delete';
  if (actions.includes('create')) return 'create';
  if (actions.includes('update')) return 'update';
  return 'no-op';
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
}));
const destructive = changes.filter((change) => ['delete', 'replace'].includes(change.action));
const blocked = destructive.filter((change) => PROTECTED_TYPES.has(change.type));

if (destructive.length > 0) {
  console.log('Destructive changes in this plan:');
  for (const change of destructive) {
    console.log(
      `  ${PROTECTED_TYPES.has(change.type) ? 'BLOCKED' : 'review'}  ${change.action}  ${change.address}`,
    );
  }
}

if (blocked.length > 0) {
  console.error(`\n${blocked.length} protected resource(s) would be destroyed or replaced.`);
  process.exit(1);
}

console.log('Destructive-change policy passed.');
