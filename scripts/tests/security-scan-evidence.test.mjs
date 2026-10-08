import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScanEvidence } from '../security-scan-evidence.mjs';

const report = (results = []) => JSON.stringify({ SchemaVersion: 2, Results: results });
const input = () => ({
  reports: { secrets: report(), iac: report() },
  outcomes: { secrets: 'success', iac: 'success', seeded: 'success' },
  sourceCommit: 'a'.repeat(40),
});

test('accepts complete clean scan evidence', () => {
  assert.equal(buildScanEvidence(input()).passed, true);
});

test('rejects startup errors, missing reports, skipped steps, and missing source identity', () => {
  for (const kind of ['secrets', 'iac', 'seeded']) {
    for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
      const value = input();
      value.outcomes[kind] = outcome;
      assert.equal(buildScanEvidence(value).passed, false);
    }
  }
  for (const kind of ['secrets', 'iac']) {
    for (const raw of ['', '{}', 'not json']) {
      const value = input();
      value.reports[kind] = raw;
      assert.equal(buildScanEvidence(value).passed, false);
    }
  }
  assert.equal(buildScanEvidence({ ...input(), sourceCommit: undefined }).passed, false);
});

test('blocks findings even when a scanner falsely reports success and retains no secret payload', () => {
  const value = input();
  value.reports.secrets = report([
    {
      Target: 'source.env',
      Secrets: [
        {
          RuleID: 'test',
          Severity: 'LOW',
          Match: 'sensitive-value',
          Code: { Lines: [{ Content: 'sensitive-value' }] },
          StartLine: 2,
        },
      ],
    },
  ]);
  const result = buildScanEvidence(value);
  assert.equal(result.passed, false);
  assert.equal(result.scans[0].findings[0].startLine, 2);
  assert.equal(JSON.stringify(result).includes('sensitive-value'), false);
});

test('blocks high and critical IaC findings without suppressing lower severity evidence', () => {
  for (const severity of ['LOW', 'HIGH', 'CRITICAL']) {
    const value = input();
    value.reports.iac = report([
      { Target: 'main.tf', Misconfigurations: [{ ID: 'test', Severity: severity }] },
    ]);
    assert.equal(buildScanEvidence(value).passed, severity === 'LOW');
  }
});
