import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildFailureEvidence, parseArgs } from '../gasless-failure-evidence.mjs';

test('gasless failure evidence parser rejects unknown scenarios', () => {
  assert.throws(
    () => parseArgs(['--scenario', 'happy_path', '--evidence-ref', 'RUN-1']),
    /--scenario must be one of/,
  );
});

test('gasless failure evidence proves relayer outage with paused readiness', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gasless-failure-'));
  const readinessFile = path.join(tmpDir, 'readiness.json');
  fs.writeFileSync(
    readinessFile,
    JSON.stringify({
      data: {
        enabled: true,
        paused: true,
        state: 'paused',
        alerts: [{ code: 'gasless_broadcast_paused' }],
      },
    }),
  );

  const report = buildFailureEvidence(
    {
      scenario: 'relayer_outage_or_disabled',
      evidenceRef: 'RUN-RELAYER-OUTAGE',
      readinessFile,
      fallbackFile: null,
      noUserEthRequired: true,
      fallbackPresented: false,
      operatorRecoveryCaptured: false,
      droppedExecutionCaptured: false,
    },
    new Date('2026-05-30T00:00:00.000Z'),
  );

  assert.equal(report.status, 'passed');
  assert.equal(report.checks.readinessCaptured, true);
  assert.equal(report.checks.broadcastPausedOrDisabled, true);
  assert.equal(report.checks.noUserEthRequired, true);
});

test('gasless failure evidence rejects operator failure proof without alert or dropped execution', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gasless-failure-'));
  const readinessFile = path.join(tmpDir, 'readiness.json');
  fs.writeFileSync(
    readinessFile,
    JSON.stringify({
      data: {
        enabled: true,
        paused: false,
        state: 'ready',
        alerts: [],
      },
    }),
  );

  const report = buildFailureEvidence(
    {
      scenario: 'operator_failure_rehearsal',
      evidenceRef: 'RUN-FAILURE',
      readinessFile,
      fallbackFile: null,
      noUserEthRequired: false,
      fallbackPresented: false,
      operatorRecoveryCaptured: false,
      droppedExecutionCaptured: false,
    },
    new Date('2026-05-30T00:00:00.000Z'),
  );

  assert.equal(report.status, 'failed');
  assert.match(report.blockers.join('\n'), /one of these checks/);
});

test('gasless failure evidence proves fallback UX from captured fallback file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gasless-failure-'));
  const fallbackFile = path.join(tmpDir, 'fallback.json');
  fs.writeFileSync(
    fallbackFile,
    JSON.stringify({
      data: {
        fallbackPresented: true,
        operatorRecoveryPathCaptured: true,
      },
    }),
  );

  const report = buildFailureEvidence(
    {
      scenario: 'fallback_ux',
      evidenceRef: 'RUN-FALLBACK',
      readinessFile: null,
      fallbackFile,
      noUserEthRequired: true,
      fallbackPresented: false,
      operatorRecoveryCaptured: false,
      droppedExecutionCaptured: false,
    },
    new Date('2026-05-30T00:00:00.000Z'),
  );

  assert.equal(report.status, 'passed');
  assert.equal(report.checks.fallbackPresented, true);
  assert.equal(report.checks.operatorRecoveryPathCaptured, true);
});
