#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

// Exact-version resolutions are admitted only when the installed-artifact regression
// suite succeeds. Unknown advisories and every production finding remain blocking.
const verifiedAdvisoryResolutions = new Map([
  [
    'GHSA-vfj7-8cjw-p6xm',
    {
      moduleName: 'braces',
      severity: 'high',
      versions: new Set(['3.0.3']),
      patchedVersions: '<0.0.0',
      evidence: 'patches/braces@3.0.3.patch',
    },
  ],
  [
    'GHSA-528h-pc64-c93x',
    {
      moduleName: 'stream-json',
      severity: 'moderate',
      versions: new Set(['1.9.1']),
      patchedVersions: '>=3.5.0',
      evidence: 'patches/stream-json@1.9.1.patch',
    },
  ],
  [
    'GHSA-mjw6-4jj6-33hc',
    {
      moduleName: 'stream-json',
      severity: 'moderate',
      versions: new Set(['1.9.1']),
      patchedVersions: '>=3.6.0',
      evidence: 'patches/stream-json@1.9.1.patch',
    },
  ],
  [
    'GHSA-hqr4-qq8f-hg3x',
    {
      moduleName: 'stream-json',
      severity: 'moderate',
      versions: new Set(['1.9.1']),
      patchedVersions: '>=3.6.0',
      evidence:
        'strict JSON 1.9.1 has no affected JSONC parser or verifier; installed entry points checked',
    },
  ],
  [
    'GHSA-848j-6mx2-7j84',
    {
      moduleName: 'elliptic',
      severity: 'low',
      versions: new Set(['6.6.1']),
      patchedVersions: '<0.0.0',
      evidence: 'patches/elliptic@6.6.1.patch',
    },
  ],
  [
    'GHSA-gcqx-w48m-w2h4',
    {
      moduleName: 'deepmerge',
      severity: 'low',
      versions: new Set(['4.3.1']),
      patchedVersions: '<0.0.0',
      evidence: 'patches/deepmerge@4.3.1.patch',
    },
  ],
  [
    'GHSA-g3hv-75wg-m249',
    {
      moduleName: 'minimatch',
      severity: 'moderate',
      versions: new Set(['3.1.5', '5.1.9', '9.0.9', '10.2.5', '10.2.6']),
      patchedVersions: '>=11.0.1',
      evidence:
        'patched 9/10 preprocessing; affected optimization absent in legacy 3/5; installed-artifact regressions',
    },
  ],
  [
    'GHSA-3g3m-2fjr-6pw4',
    {
      moduleName: 'glob',
      severity: 'moderate',
      versions: new Set(['10.5.0', '13.0.6']),
      patchedVersions: '>=14.0.2',
      evidence: 'patches/glob@10.5.0.patch and patches/glob@13.0.6.patch',
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
    const report = JSON.parse(stdout);
    const summary = report?.metadata?.vulnerabilities;
    if (
      !summary ||
      !report.advisories ||
      Array.isArray(report.advisories) ||
      typeof report.advisories !== 'object' ||
      report.error
    )
      return null;
    if (
      !['critical', 'high', 'moderate', 'low', 'info'].every(
        (severity) => Number.isSafeInteger(summary[severity]) && summary[severity] >= 0,
      )
    )
      return null;
    return report;
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

function matchesVerifiedResolution(advisory) {
  const allowed = verifiedAdvisoryResolutions.get(advisoryId(advisory));
  if (!allowed) return false;

  const findingVersions = (advisory.findings ?? []).map((finding) => finding.version);
  return (
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
for (const [label, result] of [
  ['production audit', auditProd],
  ['full audit', auditAll],
]) {
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    console.error(`Release gate failed: ${label} command failed with exit ${result.exitCode}.`);
    failed = true;
  }
}
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
  const resolvedAdvisories = allAdvisories.filter(matchesVerifiedResolution);
  const unexpectedAdvisories = allAdvisories.filter(
    (advisory) => !matchesVerifiedResolution(advisory),
  );

  if (allSummary.total > 0 && allAdvisories.length === 0) {
    console.error('Release gate failed: full dependency audit findings could not be classified.');
    failed = true;
  }

  for (const advisory of resolvedAdvisories) {
    const resolution = verifiedAdvisoryResolutions.get(advisoryId(advisory));
    if (dependencyCompatibility.exitCode === 0) {
      console.log(
        `Verified dependency resolution: ${auditDescription(advisory)}; evidence=${resolution.evidence}; installed-artifact-check=passed`,
      );
    }
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
