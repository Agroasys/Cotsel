#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function runNpm(args) {
  try {
    const stdout = execFileSync('npm', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      exitCode: typeof error?.status === 'number' ? error.status : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    };
  }
}

function parseAudit(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function vulnerabilities(report) {
  return (
    report?.metadata?.vulnerabilities ?? {
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
      total: 0,
    }
  );
}

const auditProd = runNpm(['audit', '--omit=dev', '--json']);
const auditReport = parseAudit(auditProd.stdout);
const summary = vulnerabilities(auditReport);
const lsAll = runNpm(['ls', '--all']);

console.log('Security dependency release gate');
console.log(`Generated: ${new Date().toISOString()}`);
console.log(
  `npm audit --omit=dev: critical=${summary.critical} high=${summary.high} moderate=${summary.moderate} low=${summary.low} total=${summary.total}`,
);
console.log(`npm ls --all: exit=${lsAll.exitCode}`);

let failed = false;
if (summary.critical > 0 || summary.high > 0) {
  console.error('Release gate failed: production dependency audit has high/critical findings.');
  failed = true;
}

if (lsAll.exitCode !== 0) {
  const tail = (lsAll.stderr || lsAll.stdout).trim().split('\n').slice(-20).join('\n');
  console.error('Release gate failed: npm dependency tree is invalid.');
  if (tail) {
    console.error(tail);
  }
  failed = true;
}

if (auditProd.exitCode !== 0 && !auditReport) {
  console.error('Release gate failed: npm audit did not return parseable JSON.');
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('Result: dependency security gate passed.');
