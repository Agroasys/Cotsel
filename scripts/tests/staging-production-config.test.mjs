import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimeTerraformFiles = [
  'infra/terraform/staging-platform/runtime-gateway-auth.tf',
  'infra/terraform/staging-platform/runtime-oracle-reconciliation.tf',
  'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
];

test('AWS staging runs application services with production security semantics', async () => {
  const source = (
    await Promise.all(runtimeTerraformFiles.map((file) => readFile(file, 'utf8')))
  ).join('\n');

  assert.doesNotMatch(source, /name = "NODE_ENV", value = "staging"/);
  assert.equal(source.match(/name = "NODE_ENV", value = "production"/g)?.length, 6);
  assert.equal(source.match(/name = "COTSEL_ENVIRONMENT", value = "staging"/g)?.length, 6);
  assert.equal(source.match(/name = "AUTH_ENABLED", value = "true"/g)?.length, 2);
  assert.match(source, /name = "GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH", value = "false"/);
  assert.match(source, /name = "GATEWAY_RATE_LIMIT_ENABLED", value = "true"/);
  assert.match(source, /name = "GATEWAY_RATE_LIMIT_FAIL_OPEN", value = "false"/);
  assert.match(
    source,
    /name = "GATEWAY_RATE_LIMIT_REDIS_URL", value = "rediss:\/\/\$\{local\.redis_primary_endpoint\}:6379"/,
  );
  assert.doesNotMatch(source, /name = "GATEWAY_RATE_LIMIT_ENABLED", value = "false"/);
});

test('ECS publishes redacted reviewed configuration identities', async () => {
  const gatewayTask = await readFile('infra/terraform/staging-platform/gateway-runtime.tf', 'utf8');
  const privateTasks = await readFile(
    'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
    'utf8',
  );
  const outputs = await readFile('infra/terraform/staging-platform/outputs.tf', 'utf8');

  assert.match(gatewayTask, /gateway_reviewed_config_sha256 = sha256\(jsonencode/);
  assert.match(gatewayTask, /ReviewedConfigSha256 = local\.gateway_reviewed_config_sha256/);
  assert.match(privateTasks, /private_runtime_reviewed_config_sha256 = \{/);
  assert.match(
    privateTasks,
    /ReviewedConfigSha256 = local\.private_runtime_reviewed_config_sha256\[each\.key\]/,
  );
  assert.match(outputs, /reviewed_config_sha256 = local\.gateway_reviewed_config_sha256/);
  assert.match(
    outputs,
    /reviewed_config_sha256 = local\.private_runtime_reviewed_config_sha256\[name\]/,
  );
});
