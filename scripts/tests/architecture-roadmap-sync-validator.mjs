#!/usr/bin/env node
import fs from 'node:fs';

const mode = process.argv[2];
const reportPath = process.argv[3];

if (!mode || !reportPath) {
  throw new Error(
    'usage: node scripts/tests/architecture-roadmap-sync-validator.mjs <mode> <report-path>',
  );
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

if (mode === 'check') {
  ensure(report.pass === false, 'expected check-mode report.pass=false');
  ensure(
    Array.isArray(report.staleRows) && report.staleRows.length === 1,
    'expected one stale row recommendation',
  );
  ensure(
    report.matrix.syncMode === 'status,last-refreshed',
    `expected default sync mode to be status,last-refreshed, got ${report.matrix.syncMode}`,
  );
  ensure(
    Array.isArray(report.remainingGateIssueDrift) && report.remainingGateIssueDrift.length === 0,
    'expected zero remaining gate issue drift from cache fixture',
  );
  ensure(Boolean(report.remediation?.writeMatrix), 'expected remediation.writeMatrix command');
  ensure(
    Boolean(report.remediation?.writeMatrixNormalized),
    'expected remediation.writeMatrixNormalized command',
  );
  ensure(
    report.remediation?.writeGateIssues?.includes('--write-gate-issues --apply') === true,
    'expected remediation.writeGateIssues to require --apply',
  );
} else if (mode === 'write-min') {
  ensure(report.pass === true, 'expected default write-mode report.pass=true');
  ensure(report.matrix?.wroteChanges === true, 'expected default write mode to write changes');
  ensure(
    report.matrix?.normalizeProgress === false,
    'expected default write mode normalizeProgress=false',
  );
} else if (mode === 'write-norm') {
  ensure(report.pass === true, 'expected normalized write-mode report.pass=true');
  ensure(report.matrix?.wroteChanges === true, 'expected normalized write mode to write changes');
  ensure(
    report.matrix?.normalizeProgress === true,
    'expected normalizeProgress=true in normalized write mode',
  );
  ensure(
    Array.isArray(report.remainingStaleRows) && report.remainingStaleRows.length === 0,
    'expected no remaining stale rows after write mode',
  );
} else {
  throw new Error(`unsupported mode: ${mode}`);
}
