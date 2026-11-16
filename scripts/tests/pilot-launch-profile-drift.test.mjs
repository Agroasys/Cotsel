import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadPilotLaunchInputs } from '../lib/pilot-launch-profile.mjs';

// The profile pins values that live elsewhere in the repository. These checks make a change to
// the staging Terraform, the secret inventory or the gateway readiness contract fail CI until
// the profile is reviewed alongside it (invalidation triggers in the profile).
const { profile } = loadPilotLaunchInputs();
const read = (file) => readFileSync(file, 'utf8');
const gatewayRuntime = read('infra/terraform/staging-platform/runtime-gateway-auth.tf');
const naming = read('infra/terraform/staging-platform/naming.tf');
const variables = read('infra/terraform/staging-platform/variables.tf');
const alb = read('infra/terraform/staging-platform/alb.tf');
const gatewayEnv =
  read('gateway/src/config/env.ts') + read('gateway/src/config/gaslessEnvironment.ts');
const serverReadiness = read('gateway/src/serverReadiness.ts');

function terraformValue(name) {
  const match = gatewayRuntime.match(new RegExp(`name = "${name}", value = "([^"]*)"`));
  return match?.[1];
}

function integrationSecretNames() {
  const block = naming.match(/integration_secret_names = toset\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  return new Set([...block.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]));
}

test('pinned gateway policy matches the staging Terraform task definition', () => {
  assert.equal(terraformValue('GATEWAY_SETTLEMENT_RUNTIME'), profile.network.settlementRuntime);
  assert.equal(terraformValue('GATEWAY_CONTRACT_ADDRESS_REQUIRED'), 'true');
  assert.equal(terraformValue('GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH'), 'false');
  assert.equal(terraformValue('GATEWAY_SETTLEMENT_INGRESS_ENABLED'), 'true');
  assert.equal(terraformValue('GATEWAY_SETTLEMENT_CALLBACK_ENABLED'), 'true');
  assert.equal(terraformValue('GATEWAY_RATE_LIMIT_ENABLED'), 'true');
  assert.equal(terraformValue('GATEWAY_RATE_LIMIT_FAIL_OPEN'), 'false');
  assert.equal(
    terraformValue('GATEWAY_GASLESS_SIGNER_CUSTODY_MODE'),
    profile.sponsorship.signerCustodyMode,
  );
  assert.equal(terraformValue('GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED'), 'true');
  assert.equal(
    terraformValue('GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS'),
    String(profile.serviceAuth.settlementIngress.maxSkewSeconds),
  );
  assert.equal(
    terraformValue('GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS'),
    String(profile.serviceAuth.settlementIngress.nonceTtlSeconds),
  );
  assert.doesNotMatch(
    gatewayRuntime,
    /GATEWAY_IMMEDIATE_INSPECTION_ACCEPTANCE_ENABLED", value = "true"/,
  );
  for (const forbidden of [
    'GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY',
    'GATEWAY_EXECUTOR_PRIVATE_KEY',
    'GATEWAY_SETTLEMENT_SERVICE_SHARED_SECRET',
  ]) {
    assert.ok(!gatewayRuntime.includes(forbidden), `${forbidden} must not be configured`);
  }
  assert.match(
    gatewayRuntime,
    /name = "GATEWAY_COMMIT_SHA", value = var\.gateway_image_tag \}/,
    'release.commitSource is gateway_image_tag',
  );
  assert.equal(profile.release.commitSource, 'gateway_image_tag');
});

test('the callback URL is the canonical staging callback enforced by Terraform', () => {
  const block = variables.match(/variable "backend_settlement_callback_url" \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'backend_settlement_callback_url variable must exist');
  assert.ok(block.includes(`default     = "${profile.callback.url}"`));
  assert.ok(block.includes(`"${profile.callback.url}"`));
});

test('every secret reference names a provisioned staging secret wired into the gateway', () => {
  const provisioned = integrationSecretNames();
  const refs = [
    profile.rpc.primarySecretRef,
    profile.rpc.fallbackSecretRef,
    profile.serviceAuth.settlementIngress.keysetSecretRef,
    profile.callback.credentialSecretRef,
    profile.sponsorship.managedSignerSecretRef,
    ...profile.serviceAuth.downstream.map((entry) => entry.secretRef),
  ];
  for (const ref of refs) {
    assert.ok(provisioned.has(ref), `${ref} must be a provisioned integration secret`);
    assert.ok(
      gatewayRuntime.includes(`aws_secretsmanager_secret.platform["${ref}"]`),
      `${ref} must be referenced by the gateway task definition`,
    );
  }
});

test('the liveness probe matches the load balancer health check', () => {
  assert.ok(alb.includes(`path                = "${profile.readiness.livenessEndpoint.path}"`));
});

test('readiness dependency names match what the gateway reports', () => {
  for (const name of [
    ...profile.readiness.requiredDependencies,
    ...profile.readiness.gaslessDependencies,
  ]) {
    assert.ok(
      serverReadiness.includes(`name: '${name}'`),
      `${name} must be a gateway readiness check`,
    );
  }
});

test('every runtime variable the launch check reads is a real gateway setting', () => {
  const runtimeChecker = read('scripts/lib/pilot-launch-runtime.mjs');
  const names = new Set(
    [...runtimeChecker.matchAll(/'(GATEWAY_[A-Z_]+)'/g)].map((match) => match[1]),
  );
  for (const service of profile.serviceAuth.downstream.map((entry) =>
    entry.service.toUpperCase(),
  )) {
    for (const suffix of ['BASE_URL', 'SERVICE_API_KEY', 'SERVICE_API_SECRET']) {
      names.add(`GATEWAY_${service}_${suffix}`);
    }
  }
  for (const name of names) {
    assert.ok(gatewayEnv.includes(name), `${name} must be read by the gateway configuration`);
  }
});
