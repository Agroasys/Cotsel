// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-dependency-gate-'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
fs.writeFileSync(
  path.join(directory, 'pnpm'),
  `#!/usr/bin/env node
const state = JSON.parse(process.env.GATE_PROBE);
const args = process.argv.slice(2);
if (args[0] === 'audit') {
  const report = args.includes('--prod') ? state.prod : state.all;
  process.stdout.write(typeof report === 'string' ? report : JSON.stringify(report));
  process.exit(state.auditExit ?? (Object.keys(report.advisories ?? {}).length ? 1 : 0));
}
if (args[0] === 'run') process.exit(state.compatExit ?? 0);
if (args[0] === 'list') process.exit(state.listExit ?? 0);
process.exit(2);
`,
  { mode: 0o755 },
);
const clean = () => ({
  advisories: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
});
const finding = (changes = {}) => ({
  github_advisory_id: 'GHSA-848j-6mx2-7j84',
  module_name: 'elliptic',
  severity: 'low',
  patched_versions: '<0.0.0',
  findings: [{ version: '6.6.1', paths: ['contracts>elliptic'] }],
  ...changes,
});
function report(advisory) {
  const result = clean();
  result.advisories[advisory.github_advisory_id] = advisory;
  result.metadata.vulnerabilities[advisory.severity] = 1;
  return result;
}
function run(changes = {}) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../security-deps-gate.mjs', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        GATE_PROBE: JSON.stringify({ prod: clean(), all: clean(), ...changes }),
      },
    },
  );
}
test('clean audits and verified installed artifacts pass', () => assert.equal(run().status, 0));
test('exact patched advisory passes only with compatibility proof', () =>
  assert.equal(run({ all: report(finding()) }).status, 0));
for (const [label, changes] of [
  ['production informational finding', { prod: report(finding({ severity: 'info' })) }],
  ['unknown advisory', { all: report(finding({ github_advisory_id: 'GHSA-unknown' })) }],
  ['unverified version', { all: report(finding({ findings: [{ version: '6.6.2' }] })) }],
  ['changed severity', { all: report(finding({ severity: 'high' })) }],
  ['production finding even when patched', { prod: report(finding()) }],
  ['failed installed-artifact proof', { all: report(finding()), compatExit: 1 }],
  ['invalid dependency graph', { listExit: 1 }],
  ['unparseable audit', { all: 'invalid json' }],
  ['empty audit shape', { all: {} }],
  ['failed audit command', { auditExit: 2 }],
  [
    'unclassifiable findings',
    {
      all: {
        ...clean(),
        metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 } },
      },
    },
  ],
])
  test(`rejects ${label}`, () => {
    const result = run(changes);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Release gate failed:/);
  });
