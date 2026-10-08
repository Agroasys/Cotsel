import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubActionsAppId, requiredCheckContexts } from './wp6-governance-policy.mjs';

export const sourceCheckContexts = requiredCheckContexts.filter(
  (context) => !['dco/check', 'enforce/pr-roadmap-policy'].includes(context),
);

export function evaluateSdkSourceChecks(checkRuns) {
  const violations = [];
  for (const name of sourceCheckContexts) {
    const latest = checkRuns
      .filter((check) => check.name === name && check.app?.id === githubActionsAppId)
      .sort((a, b) => b.id - a.id)[0];
    if (latest?.status !== 'completed' || latest.conclusion !== 'success') {
      violations.push(`${name}: latest trusted check must complete successfully`);
    }
  }
  return { passed: violations.length === 0, violations };
}

function run() {
  if (
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? '')
  ) {
    throw new Error('SDK publication requires an exact main commit');
  }
  const pages = JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        `repos/Agroasys/Cotsel/commits/${process.env.GITHUB_SHA}/check-runs?per_page=100`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  const result = evaluateSdkSourceChecks(pages.flatMap((page) => page.check_runs));
  if (!result.passed) throw new Error(result.violations.join('\n'));
  console.log('Exact-main code, aggregate, and all nine image checks passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
