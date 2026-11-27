import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(
  new URL('../staging-platform/dashboard-auth-variables.tf', import.meta.url),
  'utf8',
);
const names = [
  'dashboard_session_routes_enabled',
  'dashboard_origin',
  'backend_api_task_security_group_id',
  'trusted_session_exchange_enabled',
  'trusted_session_exchange_key_policies_json',
  'admin_control_enabled',
  'admin_control_allowed_api_key_ids',
  'gateway_enable_mutations',
];
const blocks = names.map((name) => {
  const block = source.match(new RegExp(`^variable "${name}" \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(block, `Missing source variable ${name}`);
  return block;
});
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith('TF_VAR_') &&
      !name.startsWith('TF_CLI_ARGS') &&
      !['TF_DATA_DIR', 'TF_WORKSPACE'].includes(name),
  ),
);

function evaluate(inputs) {
  const directory = mkdtempSync(join(tmpdir(), 'cotsel-auth-inputs-'));
  try {
    writeFileSync(
      join(directory, 'main.tf'),
      `${blocks.join('\n')}\noutput "inputs" {\nvalue = {\n${names.map((name) => `${name} = var.${name}`).join('\n')}\n}\n}\n`,
    );
    return spawnSync(
      'terraform',
      [
        'plan',
        '-input=false',
        '-refresh=false',
        '-lock=false',
        '-no-color',
        '-detailed-exitcode',
        ...Object.entries(inputs).flatMap(([name, value]) => ['-var', `${name}=${value}`]),
      ],
      { cwd: directory, env: environment, encoding: 'utf8' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const exchange = {
  trusted_session_exchange_enabled: true,
  backend_api_task_security_group_id: 'sg-0123456789abcdef0',
  trusted_session_exchange_key_policies_json: JSON.stringify({ service: { roles: ['admin'] } }),
};
const cases = [
  ['disabled defaults', {}, true],
  ['session routes without origin', { dashboard_session_routes_enabled: true }, false],
  ['another browser origin', { dashboard_origin: 'https://other.example' }, false],
  [
    'approved session origin',
    { dashboard_session_routes_enabled: true, dashboard_origin: 'https://cotsel.agroasys.com' },
    true,
  ],
  ['exchange without API group', { ...exchange, backend_api_task_security_group_id: '' }, false],
  ['malformed group ID', { ...exchange, backend_api_task_security_group_id: 'sg-a' }, false],
  [
    'exchange without policy',
    { ...exchange, trusted_session_exchange_key_policies_json: '' },
    false,
  ],
  ['invalid policy JSON', { ...exchange, trusted_session_exchange_key_policies_json: '{' }, false],
  ['empty policy map', { ...exchange, trusted_session_exchange_key_policies_json: '{}' }, false],
  [
    'read-only exchange ceiling',
    {
      ...exchange,
      trusted_session_exchange_key_policies_json: JSON.stringify({ reader: { roles: ['buyer'] } }),
    },
    true,
  ],
  ['configured administrator exchange', exchange, true],
  ['mutations without exchange', { gateway_enable_mutations: true }, false],
  [
    'mutations without administrator ceiling',
    {
      ...exchange,
      gateway_enable_mutations: true,
      trusted_session_exchange_key_policies_json: JSON.stringify({ reader: { roles: ['buyer'] } }),
    },
    false,
  ],
  [
    'mixed least-privilege exchange policies',
    {
      ...exchange,
      gateway_enable_mutations: true,
      trusted_session_exchange_key_policies_json: JSON.stringify({
        reader: { roles: ['buyer'] },
        operator: { roles: ['admin'] },
      }),
    },
    true,
  ],
  [
    'unknown exchange role',
    {
      ...exchange,
      trusted_session_exchange_key_policies_json: JSON.stringify({
        service: { roles: ['admin', 'oracle'] },
      }),
    },
    false,
  ],
  [
    'separate admin control',
    {
      admin_control_enabled: true,
      backend_api_task_security_group_id: exchange.backend_api_task_security_group_id,
      admin_control_allowed_api_key_ids: 'first,second',
    },
    true,
  ],
  [
    'duplicate admin key IDs',
    {
      admin_control_enabled: true,
      backend_api_task_security_group_id: exchange.backend_api_task_security_group_id,
      admin_control_allowed_api_key_ids: 'first,first',
    },
    false,
  ],
  [
    'admin control without private group',
    { admin_control_enabled: true, admin_control_allowed_api_key_ids: 'first,second' },
    false,
  ],
];

for (const [description, inputs, allowed] of cases) {
  test(`Terraform activation inputs: ${description}`, () => {
    const result = evaluate(inputs);
    if (allowed) {
      assert.ok([0, 2].includes(result.status), result.stderr || result.error?.message);
    } else {
      assert.equal(result.status, 1, result.stderr || result.error?.message);
      assert.match(result.stderr, /Invalid value for variable/);
    }
  });
}
