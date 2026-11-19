// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  MAX_PRODUCTION_DISPOSITION_DAYS,
  productionDispositionFailure,
} from '../dependency-disposition.mjs';

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
  github_advisory_id: 'GHSA-vfj7-8cjw-p6xm',
  module_name: 'braces',
  severity: 'high',
  patched_versions: '<0.0.0',
  findings: [{ version: '3.0.3', paths: ['contracts>braces'] }],
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
  ['changed severity', { all: report(finding({ severity: 'low' })) }],
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

const minimatchAdvisory = JSON.parse(
  fs.readFileSync(new URL('./fixtures/minimatch-current-advisory.json', import.meta.url), 'utf8'),
);
test('reviewed narrowed minimatch advisory passes with installed-artifact proof', () => {
  const result = run({ all: report(minimatchAdvisory) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
for (const [label, changes] of [
  ['previous broader range', { vulnerable_versions: '<11.0.1' }],
  ['changed overview', { overview: minimatchAdvisory.overview + ' changed' }],
  ['unverified installed version', { findings: [{ version: '10.2.7' }] }],
])
  test(`minimatch rejects ${label}`, () => {
    const result = run({ all: report({ ...minimatchAdvisory, ...changes }) });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /unexpected dependency advisory: GHSA-g3hv-75wg-m249/);
  });
test('reviewed minimatch advisory still requires installed-artifact proof', () => {
  const result = run({ all: report(minimatchAdvisory), compatExit: 1 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

const OVERVIEW = 'Example production advisory with no upstream release.';
const productionAdvisory = (changes = {}) => ({
  github_advisory_id: 'GHSA-xxxx-xxxx-xxxx',
  module_name: 'example-package',
  severity: 'high',
  vulnerable_versions: '<=1.2.3',
  patched_versions: '<0.0.0',
  overview: OVERVIEW,
  findings: [{ version: '1.2.3', paths: ['indexer>example-package'] }],
  ...changes,
});
const NOW = new Date('2026-11-19T12:00:00Z');
const productionDisposition = (changes = {}) => ({
  moduleName: 'example-package',
  severity: 'high',
  vulnerableVersions: '<=1.2.3',
  patchedVersions: '<0.0.0',
  overviewHash: createHash('sha256').update(OVERVIEW).digest('hex'),
  versions: new Set(['1.2.3']),
  paths: new Set(['indexer>example-package']),
  patchFile: 'patches/example-package@1.2.3.patch',
  expiresOn: '2026-12-18',
  dispositionDocument: 'docs/security/example-disposition.md',
  owner: 'Security',
  ...changes,
});

test('a complete production disposition accepts its exact advisory and path', () => {
  assert.equal(
    productionDispositionFailure(productionAdvisory(), productionDisposition(), NOW),
    undefined,
  );
});

test('a production disposition rejects an unreviewed dependency path', () => {
  const advisory = productionAdvisory({
    findings: [{ version: '1.2.3', paths: ['gateway>new-package>example-package'] }],
  });
  assert.match(
    productionDispositionFailure(advisory, productionDisposition(), NOW),
    /outside the reviewed production disposition/,
  );
});

test('a production disposition rejects changed advisory content or versions', () => {
  for (const advisory of [
    productionAdvisory({ overview: `${OVERVIEW} Updated.` }),
    productionAdvisory({ vulnerable_versions: '<=1.2.4' }),
    productionAdvisory({ findings: [{ version: '1.2.4', paths: ['indexer>example-package'] }] }),
  ]) {
    assert.match(
      productionDispositionFailure(advisory, productionDisposition(), NOW),
      /does not match the reviewed production disposition/,
    );
  }
});

test('a production disposition must carry every review field', () => {
  for (const field of [
    'overviewHash',
    'vulnerableVersions',
    'patchFile',
    'dispositionDocument',
    'owner',
  ]) {
    assert.match(
      productionDispositionFailure(
        productionAdvisory(),
        productionDisposition({ [field]: undefined }),
        NOW,
      ),
      new RegExp(`missing ${field}`),
    );
  }
});

test('production dispositions expire and cannot be set far ahead', () => {
  const advisory = productionAdvisory();
  assert.equal(
    productionDispositionFailure(
      advisory,
      productionDisposition(),
      new Date('2026-12-18T12:00:00Z'),
    ),
    undefined,
  );
  assert.match(
    productionDispositionFailure(
      advisory,
      productionDisposition(),
      new Date('2026-12-19T00:00:01Z'),
    ),
    /expired on 2026-12-18/,
  );
  assert.match(
    productionDispositionFailure(advisory, productionDisposition({ expiresOn: 'soon' }), NOW),
    /no valid expiry date/,
  );
  assert.match(
    productionDispositionFailure(advisory, productionDisposition({ expiresOn: '2027-03-01' }), NOW),
    new RegExp(`more than ${MAX_PRODUCTION_DISPOSITION_DAYS} days ahead`),
  );
});

test('an unlisted production advisory still fails the gate', () => {
  const advisory = finding();
  const result = run({ prod: report(advisory), all: report(advisory) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no production disposition exists/);
});

test('a production summary count without a classified advisory fails closed', () => {
  const prod = clean();
  prod.metadata.vulnerabilities.high = 1;
  const result = run({ prod });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production dependency audit has findings/);
});
