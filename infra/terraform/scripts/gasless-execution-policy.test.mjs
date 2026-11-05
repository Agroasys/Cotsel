import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../staging-platform/', import.meta.url);
const variables = readFileSync(new URL('variables.tf', root), 'utf8');
const gateway = readFileSync(new URL('runtime-gateway-auth.tf', root), 'utf8');
const relayer = readFileSync(new URL('relayer-service.tf', root), 'utf8');
const policyVariables = ['gasless_execution_enabled', 'gasless_execution_policy']
  .map((name) => {
    const block = variables.match(new RegExp(`variable "${name}" \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(block, `${name} variable is missing`);
    return block;
  })
  .join('\n');
const gatewayPolicy = gateway.match(/ {2}gasless_policy_environment = [\s\S]*?\n {2}\]/)?.[0];
const relayerCaps = relayer
  .split('\n')
  .filter((line) => /name = "RELAYER_MAX_(FEE_PER_GAS_WEI|GAS_LIMIT|NATIVE_COST_WEI)"/.test(line))
  .join('\n');
assert.ok(gatewayPolicy && relayerCaps);
const policy = {
  max_gas_limit: 1500000,
  max_fee_per_gas_wei: '50000000',
  max_native_cost_wei: '100000000000000',
  min_executor_balance_wei: '1000000000000000',
  low_balance_alert_wei: '1500000000000000',
  capacity_target_tx_per_day: 20,
  capacity_burst_multiplier_basis_points: 20000,
  capacity_safety_margin_basis_points: 12500,
};
function evaluate(value, enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'cotsel-gasless-policy-'));
  try {
    writeFileSync(
      join(directory, 'main.tf'),
      `${policyVariables}\nlocals {\n${gatewayPolicy}\nrelayer_caps = [\n${relayerCaps}\n]\n}\noutput "configuration" { value = { enabled = var.gasless_execution_enabled, gateway = local.gasless_policy_environment, relayer = local.relayer_caps } }\n`,
    );
    writeFileSync(
      join(directory, 'input.tfvars.json'),
      JSON.stringify({ gasless_execution_enabled: enabled, gasless_execution_policy: value }),
    );
    const result = spawnSync(
      'terraform',
      ['plan', '-input=false', '-no-color', '-var-file=input.tfvars.json', '-out=plan'],
      { cwd: directory, encoding: 'utf8' },
    );
    if (result.status !== 0) return result;
    const shown = spawnSync('terraform', ['show', '-json', 'plan'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(shown.status, 0, shown.stderr);
    return {
      ...result,
      configuration: JSON.parse(shown.stdout).planned_values.outputs.configuration.value,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test('explicit policy renders matching gateway and relayer spend caps', () => {
  const result = evaluate(policy);
  assert.equal(result.status, 0, result.stderr);
  const output = result.configuration;
  const env = Object.fromEntries(output.gateway.map(({ name, value }) => [name, value]));
  for (const { name, value } of output.relayer)
    assert.equal(env[name.replace('RELAYER_', 'GATEWAY_GASLESS_')], value);
  assert.equal(env.GATEWAY_GASLESS_MAX_FEE_PER_GAS_WEI, '50000000');
  assert.equal(env.GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI, '1000000000000000');
  assert.equal(env.GATEWAY_GASLESS_CAPACITY_TARGET_TX_PER_DAY, '20');
  assert.equal(env.GATEWAY_GASLESS_CAPACITY_FAIL_CLOSED, 'true');
});
test('disabled execution preserves the existing defaults without a policy', () => {
  const result = evaluate(null, false);
  assert.equal(result.status, 0, result.stderr);
  const output = result.configuration;
  assert.deepEqual(output.gateway, []);
  assert.equal(
    output.relayer.find(({ name }) => name === 'RELAYER_MAX_GAS_LIMIT').value,
    '1500000',
  );
});
test('enabled execution rejects a missing policy', () => {
  const result = evaluate(null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires an explicit execution spending and capacity/);
});
for (const [name, changed] of [
  ['zero balance floor', { min_executor_balance_wei: '0' }],
  ['noncanonical wei', { max_fee_per_gas_wei: '05' }],
  ['fractional gas limit', { max_gas_limit: 1500000.5 }],
  ['insufficient transaction cap', { max_native_cost_wei: '1' }],
  ['alert below balance floor', { low_balance_alert_wei: '1' }],
  ['insufficient safety margin', { capacity_safety_margin_basis_points: 9999 }],
])
  test(`rejects ${name}`, () => {
    const result = evaluate({ ...policy, ...changed });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid value for variable/);
  });
