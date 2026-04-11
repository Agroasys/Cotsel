#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, 'reports', 'licenses');
const jsonOut = path.join(outputDir, 'third-party-licenses.json');
const summaryOut = path.join(outputDir, 'third-party-licenses-summary.txt');

const INTERNAL_PREFIX = '@agroasys/';
const workspaceNames = new Set([
  'Cotsel',
  'contracts',
  'indexer',
  'oracle',
  '@agroasys/sdk',
  'reconciliation',
  '@agroasys/notifications',
  'ricardian',
  'treasury',
  '@agroasys/shared-auth',
]);

function runNpmLsJson() {
  try {
    return execFileSync('npm', ['-s', 'ls', '--all', '--json', '--long', '--omit=dev'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // npm ls can return non-zero while still emitting parseable JSON.
    if (
      error &&
      typeof error === 'object' &&
      'stdout' in error &&
      typeof error.stdout === 'string'
    ) {
      return error.stdout;
    }
    throw error;
  }
}

function normalizeLicense(value) {
  if (!value) return 'UNKNOWN';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return (
      value
        .map((item) => (typeof item === 'string' ? item : item?.type))
        .filter(Boolean)
        .join(' OR ') || 'UNKNOWN'
    );
  }
  if (typeof value === 'object' && value.type) return String(value.type);
  return 'UNKNOWN';
}

function collectPackages(tree) {
  const seen = new Map();

  function visit(node) {
    if (!node || typeof node !== 'object') return;

    const { name, version } = node;
    if (name && version && !name.startsWith(INTERNAL_PREFIX) && !workspaceNames.has(name)) {
      const key = `${name}@${version}`;
      if (!seen.has(key)) {
        seen.set(key, {
          name,
          version,
          license: normalizeLicense(node.license || node.licenses),
          repository: node.repository?.url || null,
        });
      }
    }

    const deps = node.dependencies || {};
    for (const child of Object.values(deps)) {
      visit(child);
    }
  }

  visit(tree);
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

function buildSummary(packages) {
  const counts = new Map();
  for (const pkg of packages) {
    const key = pkg.license || 'UNKNOWN';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const lines = [
    '# Third-Party License Summary (Production Dependencies)',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Package count: ${packages.length}`,
    '',
    'License counts:',
  ];

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [license, count] of sorted) {
    lines.push(`- ${license}: ${count}`);
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const raw = runNpmLsJson();
  const tree = JSON.parse(raw);
  const packages = collectPackages(tree);

  fs.mkdirSync(outputDir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    sourceCommand: 'npm ls --all --json --long --omit=dev',
    packageCount: packages.length,
    packages,
  };

  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(summaryOut, buildSummary(packages), 'utf8');

  console.log(`Wrote ${jsonOut}`);
  console.log(`Wrote ${summaryOut}`);
}

main();
