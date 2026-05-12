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

function parseAuditSummary(stdout) {
  try {
    const report = JSON.parse(stdout);
    return report?.metadata?.vulnerabilities ?? null;
  } catch {
    return null;
  }
}

function printAuditSection(title, result) {
  console.log(`\n${title}`);
  console.log(`- exit: ${result.exitCode}`);

  const summary = parseAuditSummary(result.stdout);
  if (summary) {
    console.log(`- total: ${summary.total}`);
    console.log(`- critical: ${summary.critical}`);
    console.log(`- high: ${summary.high}`);
    console.log(`- moderate: ${summary.moderate}`);
    console.log(`- low: ${summary.low}`);
    return;
  }

  console.log('- summary: unavailable (non-JSON output)');
  const sample = (result.stderr || result.stdout).trim().split('\n').slice(-5);
  if (sample.length > 0 && sample[0] !== '') {
    console.log('- tail:');
    for (const line of sample) {
      console.log(`  ${line}`);
    }
  }
}

function main() {
  console.log('Security dependency visibility report (non-enforcing)');
  console.log(`Generated: ${new Date().toISOString()}`);

  const auditProd = runPnpm(['audit', '--prod', '--json']);
  const auditAll = runPnpm(['audit', '--json']);
  const lsAll = runPnpm(['list', '--depth', 'Infinity']);

  printAuditSection('pnpm audit --prod --json', auditProd);
  printAuditSection('pnpm audit --json', auditAll);

  console.log('\npnpm list --depth Infinity');
  console.log(`- exit: ${lsAll.exitCode}`);
  if (lsAll.exitCode !== 0) {
    const sample = (lsAll.stderr || lsAll.stdout).trim().split('\n').slice(-10);
    if (sample.length > 0 && sample[0] !== '') {
      console.log('- tail:');
      for (const line of sample) {
        console.log(`  ${line}`);
      }
    }
  }

  console.log('\nResult: non-enforcing report complete.');
}

main();
