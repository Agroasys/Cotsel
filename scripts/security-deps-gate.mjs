#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function runPnpm(args) {
  try {
    const stdout = execFileSync('pnpm', args, {
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
  const summary = report?.metadata?.vulnerabilities ?? {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
  };
  return {
    critical: summary.critical ?? 0,
    high: summary.high ?? 0,
    moderate: summary.moderate ?? 0,
    low: summary.low ?? 0,
    total:
      summary.total ??
      (summary.critical ?? 0) + (summary.high ?? 0) + (summary.moderate ?? 0) + (summary.low ?? 0),
  };
}

const auditProd = runPnpm(['audit', '--prod', '--json']);
const auditReport = parseAudit(auditProd.stdout);
const summary = vulnerabilities(auditReport);
const lsAll = runPnpm(['list', '--depth', 'Infinity']);

console.log('Security dependency release gate');
console.log(`Generated: ${new Date().toISOString()}`);
console.log(
  `pnpm audit --prod: critical=${summary.critical} high=${summary.high} moderate=${summary.moderate} low=${summary.low} total=${summary.total}`,
);
console.log(`pnpm list --depth Infinity: exit=${lsAll.exitCode}`);

let failed = false;
if (summary.critical > 0 || summary.high > 0 || summary.moderate > 0 || summary.low > 0) {
  console.error('Release gate failed: production dependency audit has findings.');
  failed = true;
}

if (lsAll.exitCode !== 0) {
  const tail = (lsAll.stderr || lsAll.stdout).trim().split('\n').slice(-20).join('\n');
  console.error('Release gate failed: pnpm dependency tree is invalid.');
  if (tail) {
    console.error(tail);
  }
  failed = true;
}

if (auditProd.exitCode !== 0 && !auditReport) {
  console.error('Release gate failed: pnpm audit did not return parseable JSON.');
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('Result: dependency security gate passed.');
