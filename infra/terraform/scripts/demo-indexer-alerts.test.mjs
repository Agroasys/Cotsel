import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../staging-platform/', import.meta.url);
const vars = readFileSync(new URL('variables.tf', root), 'utf8');
const runtime = readFileSync(new URL('runtime-indexer.tf', root), 'utf8');
const network = readFileSync(new URL('network.tf', root), 'utf8');
const destinations = JSON.parse(readFileSync(new URL('egress-destinations.json', root), 'utf8'));
const egressConfig = network.match(/ {2}egress_destinations = \[[\s\S]*?\n {2}\]/)?.[0];
assert.ok(egressConfig, 'Egress destination configuration is missing');
const variable = vars.match(/variable "demo_disable_indexer_alerts" \{[\s\S]*?\n\}/)?.[0];
let secretConfig = runtime.match(
  / {2}indexer_pipeline_secrets = [\s\S]*?(?=\n\n {2}indexer_pipeline_container)/,
)?.[0];
assert.ok(variable && secretConfig, 'Demo alert configuration is missing');
// The conditional is unchanged; unrelated AWS resources use placeholder ARNs in this local evaluation.
secretConfig = secretConfig.replaceAll(
  /aws_secretsmanager_secret\.platform\["([^"]+)"\]\.arn/g,
  'local.secret_arns["$1"]',
);
const demo = '0xE8787748547A6ce40287CDE678A58e385b65d069';

function evaluate(
  disabled,
  address = demo,
  environment = 'staging',
  expression = 'local.indexer_pipeline_secrets',
) {
  const dir = mkdtempSync(join(tmpdir(), 'cotsel-demo-alerts-'));
  try {
    writeFileSync(
      join(dir, 'main.tf'),
      `variable "environment" { type = string }\nvariable "base_sepolia_escrow_address" { type = string }\n${variable}\nlocals {\nfoundation_secret_arns = { "notifications-webhook" = "webhook" }\nsecret_arns = { "database/indexer/runtime" = "db", "rpc-base-sepolia-primary" = "primary", "rpc-base-sepolia-fallback" = "fallback" }\n${secretConfig}\negress_contract = jsondecode(<<JSON\n${JSON.stringify(destinations)}\nJSON\n)\n${egressConfig}\n}\n`,
    );
    const args = [
      'console',
      '-no-color',
      '-var',
      `environment=${environment}`,
      '-var',
      `base_sepolia_escrow_address=${address}`,
      '-var',
      `demo_disable_indexer_alerts=${disabled}`,
    ];
    const result = spawnSync('terraform', args, {
      cwd: dir,
      input: `jsonencode(${expression})\n`,
      encoding: 'utf8',
    });
    return result.status === 0
      ? { status: 0, value: JSON.parse(JSON.parse(result.stdout.trim())) }
      : { status: result.status, error: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the webhook remains required by default and is omitted only for the selected demo', () => {
  const normal = evaluate(false);
  assert.equal(normal.status, 0, normal.error);
  assert.ok(normal.value.some((secret) => secret.name === 'NOTIFICATIONS_WEBHOOK_URL'));
  const demoResult = evaluate(true);
  assert.equal(demoResult.status, 0, demoResult.error);
  assert.ok(!demoResult.value.some((secret) => secret.name === 'NOTIFICATIONS_WEBHOOK_URL'));
  assert.ok(demoResult.value.some((secret) => secret.name === 'RPC_ENDPOINT'));
});

test('the alert exception cannot be enabled for another escrow or production', () => {
  assert.notEqual(evaluate(true, '0x1111111111111111111111111111111111111111').status, 0);
  assert.notEqual(evaluate(true, demo, 'production').status, 0);
});

test('the unresolved webhook is excluded from egress only for the selected demo', () => {
  const normal = evaluate(false, demo, 'staging', 'local.egress_destinations');
  assert.equal(normal.status, 0, normal.error);
  assert.ok(normal.value.some((entry) => entry.service === 'Notifications webhook'));
  const selected = evaluate(true, demo, 'staging', 'local.egress_destinations');
  assert.equal(selected.status, 0, selected.error);
  assert.ok(!selected.value.some((entry) => entry.service === 'Notifications webhook'));
  assert.ok(selected.value.some((entry) => entry.service === 'Base Sepolia RPC primary'));
});
