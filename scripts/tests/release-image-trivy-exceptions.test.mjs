// SPDX-License-Identifier: Apache-2.0
// Release-image Trivy exceptions must stay as narrow as the production
// dependency dispositions they mirror: same advisory, exact package versions,
// same expiry, and a disposition document that exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifiedProductionDispositions } from '../production-dependency-dispositions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IGNORE_FILE = 'config/trivy/release-image-ignore.yaml';

/** Parses the deliberately small subset of YAML this file is allowed to use. */
function parseIgnoreFile(source) {
  const lines = source.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  const header = lines.shift();
  if (header === 'vulnerabilities: []') {
    assert.equal(lines.length, 0, 'nothing may follow an empty exception list');
    return [];
  }
  assert.equal(header, 'vulnerabilities:', 'only vulnerability exceptions are allowed');
  const entries = [];
  let current;
  let inPurls = false;
  for (const line of lines) {
    let match;
    if ((match = /^ {2}- id: (\S+)$/u.exec(line))) {
      current = { id: match[1], purls: [], statement: '' };
      entries.push(current);
      inPurls = false;
    } else if (/^ {4}purls:$/u.test(line)) {
      inPurls = true;
    } else if (inPurls && (match = /^ {6}- (\S+)$/u.exec(line))) {
      current.purls.push(match[1]);
    } else if ((match = /^ {4}expired_at: (\d{4}-\d{2}-\d{2})$/u.exec(line))) {
      current.expiredAt = match[1];
      inPurls = false;
    } else if (/^ {4}statement: >-$/u.test(line)) {
      inPurls = false;
    } else if ((match = /^ {6}(.+)$/u.exec(line)) && current && !inPurls) {
      current.statement += `${match[1]} `;
    } else {
      assert.fail(`unsupported line in ${IGNORE_FILE}: ${line}`);
    }
  }
  return entries;
}

/** Returns every way the Trivy exceptions are broader than the dispositions. */
function exceptionProblems(entries, dispositions, documentExists) {
  const problems = [];
  for (const entry of entries) {
    const disposition = [...dispositions.values()].find(
      (candidate) => candidate.trivyId === entry.id,
    );
    if (!disposition) {
      problems.push(`${entry.id} has no production dependency disposition`);
      continue;
    }
    const expected = [...disposition.versions]
      .map((version) => `pkg:npm/${disposition.moduleName}@${version}`)
      .sort();
    if (JSON.stringify([...entry.purls].sort()) !== JSON.stringify(expected)) {
      problems.push(`${entry.id} must be scoped to the exact dispositioned package versions`);
    }
    if (entry.expiredAt !== disposition.expiresOn)
      problems.push(`${entry.id} expiry must match the gate`);
    if (
      !documentExists(disposition.dispositionDocument) ||
      !entry.statement.includes(disposition.dispositionDocument)
    ) {
      problems.push(`${entry.id} must cite an existing disposition document`);
    }
  }
  for (const disposition of dispositions.values()) {
    if (disposition.trivyId && !entries.some((entry) => entry.id === disposition.trivyId)) {
      problems.push(`${disposition.trivyId} has a disposition but no Trivy exception`);
    }
  }
  return problems;
}

const source = fs.readFileSync(path.join(ROOT, IGNORE_FILE), 'utf8');
const entries = parseIgnoreFile(source);
const documentExists = (file) => Boolean(file) && fs.existsSync(path.join(ROOT, file));

test('the release-image scan uses the reviewed ignore file and nothing broader', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release-images.yml'), 'utf8');
  assert.equal((workflow.match(/trivyignores:/gu) ?? []).length, 1);
  assert.match(workflow, new RegExp(`trivyignores: ${IGNORE_FILE.replaceAll('.', '\\.')}\\n`, 'u'));
  assert.doesNotMatch(workflow, /ignore-unfixed: true|skip-dirs:|skip-files:/u);
  assert.equal(fs.existsSync(path.join(ROOT, '.trivyignore')), false);
});

test('the checked-in Trivy exceptions mirror the production dispositions exactly', () => {
  assert.deepEqual(exceptionProblems(entries, verifiedProductionDispositions, documentExists), []);
});

const SAMPLE = `vulnerabilities:
  - id: CVE-2026-00001
    purls:
      - pkg:npm/example-package@1.2.3
    expired_at: 2026-12-18
    statement: >-
      No upstream release; see docs/security/example-disposition.md.
`;
const sampleDisposition = (changes = {}) =>
  new Map([
    [
      'GHSA-xxxx-xxxx-xxxx',
      {
        moduleName: 'example-package',
        versions: new Set(['1.2.3']),
        expiresOn: '2026-12-18',
        trivyId: 'CVE-2026-00001',
        dispositionDocument: 'docs/security/example-disposition.md',
        ...changes,
      },
    ],
  ]);
const sampleExists = (file) => file === 'docs/security/example-disposition.md';

test('a Trivy exception that mirrors its disposition is accepted', () => {
  assert.deepEqual(
    exceptionProblems(parseIgnoreFile(SAMPLE), sampleDisposition(), sampleExists),
    [],
  );
});

test('a Trivy exception broader or longer than its disposition is rejected', () => {
  const sample = parseIgnoreFile(SAMPLE);
  for (const [changes, problem] of [
    [{ versions: new Set(['1.2.4']) }, /exact dispositioned package versions/],
    [{ expiresOn: '2026-12-01' }, /expiry must match the gate/],
    [{ dispositionDocument: 'docs/security/missing.md' }, /existing disposition document/],
    [{ trivyId: 'CVE-2026-99999' }, /has no production dependency disposition/],
  ]) {
    assert.match(
      exceptionProblems(sample, sampleDisposition(changes), sampleExists).join('\n'),
      problem,
    );
  }
});

test('a disposition with a Trivy identifier needs a Trivy exception', () => {
  assert.match(
    exceptionProblems([], sampleDisposition(), sampleExists).join('\n'),
    /has a disposition but no Trivy exception/,
  );
});

test('the ignore file parser accepts only the reviewed subset', () => {
  assert.deepEqual(parseIgnoreFile('vulnerabilities: []\n'), []);
  assert.throws(() => parseIgnoreFile('vulnerabilities: []\n  - id: CVE-1\n'));
  assert.throws(() => parseIgnoreFile('misconfigurations:\n  - id: AVD-1\n'));
  assert.throws(() => parseIgnoreFile(`${SAMPLE}    paths:\n      - /usr\n`));
});
