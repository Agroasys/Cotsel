import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_GATE_CHECKS, evaluateReleaseGateNeeds } from '../evaluate-release-gate.mjs';

const selectionNames = [
  'auth',
  'contracts',
  'full_matrix',
  'gateway',
  'indexer',
  'notifications',
  'oracle',
  'reconciliation',
  'ricardian',
  'sdk',
  'shared',
  'treasury',
];

function makeNeeds({ selected = [], status = 'success' } = {}) {
  const outputs = Object.fromEntries(
    selectionNames.map((name) => [name, selected.includes(name) ? 'true' : 'false']),
  );
  const needs = { changes: { outputs, result: status } };
  for (const { job } of RELEASE_GATE_CHECKS) {
    needs[job] ??= { result: status };
  }
  return needs;
}

function setOptionalJobs(needs, status) {
  for (const check of RELEASE_GATE_CHECKS) {
    if (!check.required(Object.fromEntries(selectionNames.map((name) => [name, false])))) {
      needs[check.job].result = status;
    }
  }
}

test('accepts a complete full-matrix release gate', () => {
  const result = evaluateReleaseGateNeeds(makeNeeds({ selected: ['full_matrix'] }));
  assert.equal(result.passed, true);
});

test('rejects every failed critical check', () => {
  for (const { job, label } of RELEASE_GATE_CHECKS) {
    const needs = makeNeeds({ selected: ['full_matrix'] });
    needs[job].result = 'failure';
    const result = evaluateReleaseGateNeeds(needs);
    assert.equal(result.passed, false, `${label} failure must block the gate`);
  }
});

test('rejects every skipped full-matrix check', () => {
  for (const { job, label } of RELEASE_GATE_CHECKS) {
    const needs = makeNeeds({ selected: ['full_matrix'] });
    needs[job].result = 'skipped';
    const result = evaluateReleaseGateNeeds(needs);
    assert.equal(result.passed, false, `${label} skip must block the full matrix`);
  }
});

test('rejects every cancelled critical check', () => {
  for (const { job, label } of RELEASE_GATE_CHECKS) {
    const needs = makeNeeds({ selected: ['full_matrix'] });
    needs[job].result = 'cancelled';
    const result = evaluateReleaseGateNeeds(needs);
    assert.equal(result.passed, false, `${label} cancellation must block the gate`);
  }
});

test('accepts legitimate path-filter skips', () => {
  const needs = makeNeeds({ selected: ['gateway'] });
  setOptionalJobs(needs, 'skipped');
  needs.gateway.result = 'success';
  const result = evaluateReleaseGateNeeds(needs);
  assert.equal(result.passed, true);
});

test('rejects a selected path that is skipped', () => {
  const needs = makeNeeds({ selected: ['gateway'] });
  setOptionalJobs(needs, 'skipped');
  needs.gateway.result = 'skipped';
  const result = evaluateReleaseGateNeeds(needs);
  assert.equal(result.passed, false);
  assert.match(result.failures[0].reason, /ci\/gateway was required but finished with skipped/);
});

test('shared changes require every path-filtered check', () => {
  const needs = makeNeeds({ selected: ['shared'] });
  needs.treasury.result = 'skipped';
  const result = evaluateReleaseGateNeeds(needs);
  assert.equal(result.passed, false);
  assert.match(result.failures[0].reason, /ci\/treasury was required but finished with skipped/);
});

test('rejects missing path-selection output', () => {
  const needs = makeNeeds();
  delete needs.changes.outputs.gateway;
  assert.throws(
    () => evaluateReleaseGateNeeds(needs),
    /changes\.outputs\.gateway must be "true" or "false"/,
  );
});

test('rejects an unknown job result', () => {
  const needs = makeNeeds();
  needs['runtime-gate'] = { result: 'neutral' };
  const result = evaluateReleaseGateNeeds(needs);
  assert.equal(result.passed, false);
  assert.match(result.failures[0].reason, /invalid or missing result/);
});

test('command writes the release-gate report', () => {
  const reportPath = path.join(os.tmpdir(), `cotsel-release-gate-${process.pid}.txt`);
  const scriptPath = fileURLToPath(new URL('../evaluate-release-gate.mjs', import.meta.url));
  try {
    const result = spawnSync(process.execPath, [scriptPath, '--report', reportPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_GATE_NEEDS_JSON: JSON.stringify(makeNeeds({ selected: ['full_matrix'] })),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(reportPath, 'utf8'), /ci\/treasury => success \(required\)/);
  } finally {
    fs.rmSync(reportPath, { force: true });
  }
});

test('command preserves a report when the needs payload is invalid', () => {
  const reportPath = path.join(os.tmpdir(), `cotsel-release-gate-invalid-${process.pid}.txt`);
  const scriptPath = fileURLToPath(new URL('../evaluate-release-gate.mjs', import.meta.url));
  try {
    const result = spawnSync(process.execPath, [scriptPath, '--report', reportPath], {
      encoding: 'utf8',
      env: { ...process.env, RELEASE_GATE_NEEDS_JSON: '{}' },
    });
    assert.equal(result.status, 1);
    assert.match(
      fs.readFileSync(reportPath, 'utf8'),
      /changes\.outputs\.full_matrix must be "true" or "false"/,
    );
  } finally {
    fs.rmSync(reportPath, { force: true });
  }
});

test('workflow delegates exactly every required job result to the policy evaluator', () => {
  const workflowPath = fileURLToPath(
    new URL('../../.github/workflows/release-gate.yml', import.meta.url),
  );
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const releaseGate = workflow.slice(workflow.indexOf('  release-gate:'));
  const needsBlock = releaseGate.slice(
    releaseGate.indexOf('    needs:'),
    releaseGate.indexOf('    steps:'),
  );
  const wiredJobs = needsBlock
    .split('\n')
    .filter((line) => line.startsWith('      - '))
    .map((line) => line.slice('      - '.length))
    .sort();
  const evaluatedJobs = RELEASE_GATE_CHECKS.map(({ job }) => job).sort();

  assert.match(releaseGate, /if: always\(\)/);
  assert.match(releaseGate, /RELEASE_GATE_NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(
    releaseGate,
    /run: node scripts\/evaluate-release-gate\.mjs --report ci-reports\/release-gate\.txt/,
  );
  assert.deepEqual(
    wiredJobs,
    evaluatedJobs,
    'release-gate.needs and RELEASE_GATE_CHECKS must contain the same jobs',
  );
});

test('shared package changes select every transitive consumer through the full shared matrix', () => {
  const workflowPath = fileURLToPath(
    new URL('../../.github/workflows/release-gate.yml', import.meta.url),
  );
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const sharedFilter = workflow.slice(
    workflow.indexOf('            shared:'),
    workflow.indexOf('            contracts:'),
  );

  for (const workspace of ['shared-auth', 'shared-db', 'shared-edge', 'shared-http']) {
    assert.match(sharedFilter, new RegExp(`- '${workspace}/\\*\\*'`));
  }

  const needs = makeNeeds({ selected: ['shared'] });
  for (const { job, label } of RELEASE_GATE_CHECKS) {
    if (job === 'changes') continue;
    needs[job].result = 'skipped';
    const result = evaluateReleaseGateNeeds(needs);
    assert.equal(result.passed, false, `${label} must run for a shared package change`);
    needs[job].result = 'success';
  }
});
