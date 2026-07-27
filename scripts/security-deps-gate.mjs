#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const developmentAuditAllowlist = new Map([
  [
    'GHSA-848j-6mx2-7j84',
    {
      moduleName: 'elliptic',
      severity: 'low',
      versions: new Set(['6.6.1']),
      patchedVersions: '<0.0.0',
      owner: 'Cotsel security maintainers',
      expiresOn: '2026-10-31',
      reason:
        'No patched release exists. The affected path is limited to development-only Hardhat tooling.',
    },
  ],
]);

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

function advisories(report) {
  return Object.values(report?.advisories ?? {});
}

function advisoryId(advisory) {
  return advisory?.github_advisory_id ?? String(advisory?.id ?? 'unknown');
}

function matchesDevelopmentAllowlist(advisory, currentDate = new Date()) {
  const allowed = developmentAuditAllowlist.get(advisoryId(advisory));
  if (!allowed) {
    return false;
  }

  const expiresAt = new Date(`${allowed.expiresOn}T23:59:59Z`);
  const findingVersions = (advisory.findings ?? []).map((finding) => finding.version);

  return (
    currentDate <= expiresAt &&
    advisory.module_name === allowed.moduleName &&
    advisory.severity === allowed.severity &&
    advisory.patched_versions === allowed.patchedVersions &&
    findingVersions.length > 0 &&
    findingVersions.every((version) => allowed.versions.has(version))
  );
}

function auditDescription(advisory) {
  const versions = [...new Set((advisory.findings ?? []).map((finding) => finding.version))];
  return `${advisoryId(advisory)} ${advisory.module_name ?? 'unknown-package'}@${versions.join(',') || 'unknown'} (${advisory.severity ?? 'unknown-severity'})`;
}

const auditProd = runPnpm(['audit', '--prod', '--json']);
const auditProdReport = parseAudit(auditProd.stdout);
const prodSummary = vulnerabilities(auditProdReport);
const auditAll = runPnpm(['audit', '--json']);
const auditAllReport = parseAudit(auditAll.stdout);
const allSummary = vulnerabilities(auditAllReport);
const dependencyCompatibility = runPnpm(['run', 'security:deps:compat']);
const lsAll = runPnpm(['list', '--depth', 'Infinity']);

console.log('Security dependency release gate');
console.log(`Generated: ${new Date().toISOString()}`);
console.log(
  `pnpm audit --prod: critical=${prodSummary.critical} high=${prodSummary.high} moderate=${prodSummary.moderate} low=${prodSummary.low} total=${prodSummary.total}`,
);
console.log(
  `pnpm audit: critical=${allSummary.critical} high=${allSummary.high} moderate=${allSummary.moderate} low=${allSummary.low} total=${allSummary.total}`,
);
console.log(`dependency compatibility: exit=${dependencyCompatibility.exitCode}`);
console.log(`pnpm list --depth Infinity: exit=${lsAll.exitCode}`);

let failed = false;
if (
  prodSummary.critical > 0 ||
  prodSummary.high > 0 ||
  prodSummary.moderate > 0 ||
  prodSummary.low > 0
) {
  console.error('Release gate failed: production dependency audit has findings.');
  failed = true;
}

if (auditAllReport) {
  const allAdvisories = advisories(auditAllReport);
  const acceptedAdvisories = allAdvisories.filter(matchesDevelopmentAllowlist);
  const unexpectedAdvisories = allAdvisories.filter(
    (advisory) => !matchesDevelopmentAllowlist(advisory),
  );

  if (allSummary.total > 0 && allAdvisories.length === 0) {
    console.error('Release gate failed: full dependency audit findings could not be classified.');
    failed = true;
  }

  for (const advisory of acceptedAdvisories) {
    const allowed = developmentAuditAllowlist.get(advisoryId(advisory));
    console.log(
      `Accepted development advisory: ${auditDescription(advisory)}; owner=${allowed.owner}; expires=${allowed.expiresOn}; reason=${allowed.reason}`,
    );
  }

  for (const advisory of unexpectedAdvisories) {
    console.error(
      `Release gate failed: unexpected dependency advisory: ${auditDescription(advisory)}`,
    );
    failed = true;
  }
}

if (dependencyCompatibility.exitCode !== 0) {
  const tail = (dependencyCompatibility.stderr || dependencyCompatibility.stdout)
    .trim()
    .split('\n')
    .slice(-20)
    .join('\n');
  console.error('Release gate failed: dependency compatibility check failed.');
  if (tail) {
    console.error(tail);
  }
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

if (!auditProdReport) {
  console.error('Release gate failed: production dependency audit did not return parseable JSON.');
  failed = true;
}

if (!auditAllReport) {
  console.error('Release gate failed: full dependency audit did not return parseable JSON.');
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('Result: dependency security gate passed.');
