import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadStagingGateSqlContract, sqlFingerprint } from './helpers/stagingGateSqlContract';

function loadGateScript(): string {
  const gatePath = path.resolve(__dirname, '../../../scripts/staging-e2e-real-gate.sh');
  return fs.readFileSync(gatePath, 'utf8');
}

const EXPECTED_RUN_SUMMARY_SQL = [
  "SELECT replace(COALESCE(status::text, ''), chr(31), ' '), total_trades, drift_count",
  'FROM reconcile_runs',
  "WHERE run_key = :'run_key_var'",
  'ORDER BY id DESC',
  'LIMIT 1;',
].join('\n');

const EXPECTED_DRIFT_SUMMARY_SQL = [
  "SELECT replace(COALESCE(mismatch_code::text, ''), chr(31), ' '), COUNT(*)",
  'FROM reconcile_drifts',
  "WHERE run_key = :'run_key_var'",
  'GROUP BY mismatch_code',
  'ORDER BY COUNT(*) DESC;',
].join('\n');

const EXPECTED_SQL_FINGERPRINTS = {
  runSummarySql: 'a7efe230f0f01bbea76111e5da4561d25d875e13d0f22aafa59a597332bc63ca',
  driftSummarySql: '5f1c1e667a6e0d74ad1d28219a5fcfb3c6ff3776f9fb92340410ee5f50b6b312',
} as const;

test('staging-e2e-real gate captures reconciliation run summary output', () => {
  const script = loadGateScript();
  const sql = loadStagingGateSqlContract(script);

  assert.match(script, /reconciliation run summary:/);
  assert.equal(sql.runSummarySql, EXPECTED_RUN_SUMMARY_SQL);
});

test('staging-e2e-real gate captures drift classification snapshot output', () => {
  const script = loadGateScript();
  const sql = loadStagingGateSqlContract(script);

  assert.match(script, /drift classification snapshot:/);
  assert.equal(sql.driftSummarySql, EXPECTED_DRIFT_SUMMARY_SQL);
});

test('staging-e2e-real gate SQL fingerprint stays stable unless SQL changes intentionally', () => {
  const sql = loadStagingGateSqlContract();

  // Keep a short hash signal in CI output so SQL changes are obvious in diffs.
  assert.equal(sqlFingerprint(sql.runSummarySql), EXPECTED_SQL_FINGERPRINTS.runSummarySql);
  assert.equal(sqlFingerprint(sql.driftSummarySql), EXPECTED_SQL_FINGERPRINTS.driftSummarySql);
});

test('staging-e2e-real SQL extractor reports actionable marker errors when script format changes', () => {
  assert.throws(
    () => loadStagingGateSqlContract('#!/usr/bin/env bash\necho "no sql markers"\n'),
    /staging-e2e-real gate script format changed, update markers in stagingGateSqlContract\.ts/,
  );
});

test('staging-e2e-real gate writes deterministic reconciliation report output', () => {
  const script = loadGateScript();

  assert.match(script, /reports\/reconciliation\/staging-e2e-real-report\.json/);
  assert.match(script, /node reconciliation\/dist\/report-cli\.js --run-key=/);
});

test('staging-e2e-real gate emits config-only reconciliation report payload', () => {
  const script = loadGateScript();

  assert.match(script, /STAGING_E2E_REAL_GATE_ASSERT_CONFIG_ONLY/);
  assert.match(script, /mode\": \"config-only\"/);
});
