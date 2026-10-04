import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = 'infra/terraform/staging-platform';
const contract = JSON.parse(readFileSync(join(ROOT, 'egress-destinations.json'), 'utf8'));
const network = readFileSync(join(ROOT, 'network.tf'), 'utf8');
const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function resourceBlocks(source) {
  const blocks = [];
  const pattern = /resource "([^"]+)" "([^"]+)" \{/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 0;
    let end = match.index;
    for (let index = source.indexOf('{', match.index); index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
    const preceding = source.slice(0, match.index).trimEnd().split('\n').at(-1);
    blocks.push({
      type: match[1],
      name: match[2],
      body: source.slice(match.index, end),
      preceding,
    });
  }
  return blocks;
}

test('every Cotsel egress destination is a bare hostname or explicitly unresolved', () => {
  assert.equal(contract.environment, 'staging');
  assert.ok(contract.entries.length > 0);

  for (const entry of contract.entries) {
    assert.ok(entry.service, 'entry needs a service');
    assert.ok(Array.isArray(entry.workloads) && entry.workloads.length > 0, entry.service);
    assert.ok(['required', 'unresolved'].includes(entry.status), entry.service);

    if (entry.status === 'required') {
      assert.match(entry.hostname, HOSTNAME, `${entry.service} must be a bare lowercase hostname`);
    } else {
      assert.equal(entry.hostname, null, `${entry.service} is unresolved and must not guess`);
    }
  }
});

test('hostnames never carry a scheme, path, port, or credential', () => {
  for (const entry of contract.entries) {
    if (entry.hostname !== null) {
      assert.doesNotMatch(entry.hostname, /[/:@?#]/, entry.service);
    }
  }
});

test('the enforcement gate requires default-deny and approval of every destination', () => {
  const gate = resourceBlocks(network).find(
    (block) => block.type === 'terraform_data' && block.name === 'egress_enforcement_gate',
  );
  assert.ok(gate, 'terraform_data.egress_enforcement_gate is missing');
  assert.match(gate.body, /denied_by_default/);
  assert.match(gate.body, /unresolved_egress_destinations/);
  assert.match(gate.body, /unapproved_egress_destinations/);
  assert.match(network, /approved_tls_names/);
});

test('internet egress is TLS 443 only, gated, and its scan exception is firewall-backed', () => {
  const open = resourceBlocks(network).filter((block) => block.body.includes('"0.0.0.0/0"'));
  assert.deepEqual(open.map((block) => block.name).sort(), ['gateway_https', 'services_https']);

  for (const rule of open) {
    assert.match(rule.body, /from_port\s+= 443/, rule.name);
    assert.match(rule.body, /to_port\s+= 443/, rule.name);
    assert.match(rule.body, /depends_on = \[terraform_data\.egress_enforcement_gate\]/, rule.name);
    assert.match(rule.preceding, /^#trivy:ignore:AVD-AWS-0104:exp:\d{4}-\d{2}-\d{2}$/, rule.name);
  }
});

test('no other staging-platform file opens internet egress', () => {
  for (const file of readdirSync(ROOT).filter((name) => name.endsWith('.tf'))) {
    if (file === 'network.tf') continue;
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /0\.0\.0\.0\/0/, file);
  }
});
