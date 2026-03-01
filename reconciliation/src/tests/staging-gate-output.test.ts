import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function loadGateScript(): string {
  const gatePath = path.resolve(__dirname, '../../../scripts/staging-e2e-real-gate.sh');
  return fs.readFileSync(gatePath, 'utf8');
}

test('staging-e2e-real gate captures reconciliation run summary output', () => {
  const script = loadGateScript();

  assert.match(script, /reconciliation run summary:/);
  assert.match(script, /RUN_SUMMARY_SQL=/);
  assert.match(script, /SELECT replace\(COALESCE\(status::text, ''\), chr\(31\), ' '\), total_trades, drift_count/);
  assert.match(script, /WHERE run_key = :'run_key_var'/);
});

test('staging-e2e-real gate captures drift classification snapshot output', () => {
  const script = loadGateScript();

  assert.match(script, /drift classification snapshot:/);
  assert.match(script, /DRIFT_SUMMARY_SQL=/);
  assert.match(script, /SELECT replace\(COALESCE\(mismatch_code::text, ''\), chr\(31\), ' '\), COUNT\(\*\)/);
  assert.match(script, /FROM reconcile_drifts/);
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
