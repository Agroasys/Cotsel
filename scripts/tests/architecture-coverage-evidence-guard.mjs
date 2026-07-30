#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const matrixPath = path.join(repositoryRoot, 'docs/runbooks/architecture-coverage-matrix.md');

const controlledRows = [
  {
    component: 'Indexer pipeline + GraphQL schema correctness',
    blockers: ['H-06', 'B-19'],
  },
  {
    component: 'Reconciliation drift remediation',
    blockers: ['B-07'],
  },
  {
    component: 'Release gates + profile health determinism',
    blockers: ['B-16'],
  },
  {
    component: 'Treasury external handoff + audit traceability',
    blockers: ['B-08', 'B-09'],
  },
  {
    component: 'Reconciliation reports (on-chain ↔ fiat evidence)',
    blockers: ['B-07'],
  },
  {
    component: 'Infrastructure controls (CI/CD, roadmap governance, release controls)',
    blockers: ['B-16'],
  },
  {
    component: 'Primary DB operations + recovery evidence',
    blockers: ['B-13'],
  },
  {
    component: 'Shared notifications library behavior + operational controls',
    blockers: ['H-26'],
  },
  {
    component: 'API gateway orchestration + error handoff boundary',
    blockers: ['H-26'],
  },
  {
    component:
      'Governance signing model — human privileged governance → direct admin wallet signing',
    blockers: ['WP-9A'],
  },
];

function parseRows(markdown) {
  return markdown
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('| '))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter(
      (cells) => cells.length === 10 && cells[0] !== 'Component' && !/^[-: ]+$/u.test(cells[0]),
    )
    .map((cells) => ({
      component: cells[0],
      status: cells[2],
      evidence: cells[5],
      gap: cells[6],
    }));
}

function extractRepositoryPaths(evidence) {
  const tokens = [...evidence.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
  return tokens.filter(
    (token) =>
      token.includes('/') && !token.includes('://') && !token.includes('<') && !token.includes('>'),
  );
}

const rows = parseRows(fs.readFileSync(matrixPath, 'utf8'));
const failures = [];

if (rows.length === 0) {
  failures.push('the component mapping table contains no parseable rows');
}

for (const row of rows) {
  const evidencePaths = extractRepositoryPaths(row.evidence);
  if (row.status !== 'Out of Scope' && evidencePaths.length === 0) {
    failures.push(`${row.component}: active row has no repository-path evidence`);
  }

  for (const evidencePath of evidencePaths) {
    if (!fs.existsSync(path.join(repositoryRoot, evidencePath))) {
      failures.push(`${row.component}: evidence path does not exist: ${evidencePath}`);
    }
  }
}

for (const control of controlledRows) {
  const row = rows.find(({ component }) => component === control.component);
  if (!row) {
    failures.push(`${control.component}: controlled matrix row is missing`);
    continue;
  }

  if (row.status !== 'In Progress') {
    failures.push(
      `${control.component}: must remain In Progress while ${control.blockers.join(
        ', ',
      )} is open (found ${row.status})`,
    );
  }

  for (const blocker of control.blockers) {
    if (!row.gap.includes(blocker)) {
      failures.push(`${control.component}: remaining gap must cite ${blocker}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Architecture coverage evidence guard failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Architecture coverage evidence guard passed for ${rows.length} component rows and ${controlledRows.length} blocker-controlled rows.`,
);
