import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPTIONAL_SELECTIONS = [
  'auth',
  'contracts',
  'gateway',
  'indexer',
  'notifications',
  'oracle',
  'reconciliation',
  'ricardian',
  'sdk',
  'shared',
  'treasury',
];

export const RELEASE_GATE_CHECKS = [
  { job: 'changes', label: 'ci/changes', required: () => true },
  {
    job: 'dependency-security',
    label: 'ci/dependency-security',
    required: (selected) => selected.full_matrix || selected.shared,
  },
  { job: 'docs-profile-guard', label: 'ci/docs-profile-guard', required: () => true },
  { job: 'env-profile-regression', label: 'ci/env-profile-regression', required: () => true },
  {
    job: 'repo-quality',
    label: 'ci/repo-quality',
    required: (selected) => selected.full_matrix || selected.shared,
  },
  {
    job: 'shared-packages',
    label: 'ci/shared-packages',
    required: (selected) => selected.full_matrix || selected.shared,
  },
  {
    job: 'postgres-recovery-smoke',
    label: 'ci/postgres-recovery-smoke',
    required: () => true,
  },
  {
    job: 'cross-repository-compatibility',
    label: 'ci/cross-repository-compatibility',
    required: () => true,
  },
  { job: 'runtime-gate', label: 'ci/runtime-gate', required: () => true },
  {
    job: 'auth',
    label: 'ci/auth',
    required: (selected) => selected.full_matrix || selected.shared || selected.auth,
  },
  {
    job: 'gateway',
    label: 'ci/gateway',
    required: (selected) => selected.full_matrix || selected.shared || selected.gateway,
  },
  {
    job: 'contracts',
    label: 'ci/contracts',
    required: (selected) => selected.full_matrix || selected.shared || selected.contracts,
  },
  {
    job: 'sdk',
    label: 'ci/sdk',
    required: (selected) => selected.full_matrix || selected.shared || selected.sdk,
  },
  {
    job: 'oracle',
    label: 'ci/oracle',
    required: (selected) =>
      selected.full_matrix ||
      selected.shared ||
      selected.oracle ||
      selected.sdk ||
      selected.notifications,
  },
  {
    job: 'indexer',
    label: 'ci/indexer',
    required: (selected) => selected.full_matrix || selected.shared || selected.indexer,
  },
  {
    job: 'notifications',
    label: 'ci/notifications',
    required: (selected) => selected.full_matrix || selected.shared || selected.notifications,
  },
  {
    job: 'reconciliation',
    label: 'ci/reconciliation',
    required: (selected) =>
      selected.full_matrix ||
      selected.shared ||
      selected.reconciliation ||
      selected.sdk ||
      selected.notifications,
  },
  {
    job: 'ricardian',
    label: 'ci/ricardian',
    required: (selected) => selected.full_matrix || selected.shared || selected.ricardian,
  },
  {
    job: 'treasury',
    label: 'ci/treasury',
    required: (selected) => selected.full_matrix || selected.shared || selected.treasury,
  },
];

function parseSelection(outputs) {
  const selected = {};
  for (const name of ['full_matrix', ...OPTIONAL_SELECTIONS]) {
    const value = outputs?.[name];
    if (value !== 'true' && value !== 'false') {
      throw new Error(`changes.outputs.${name} must be "true" or "false"`);
    }
    selected[name] = value === 'true';
  }
  return selected;
}

export function evaluateReleaseGateNeeds(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
    throw new Error('release gate needs must be an object');
  }

  const selected = parseSelection(needs.changes?.outputs);
  const evaluations = RELEASE_GATE_CHECKS.map((check) => {
    const status = needs[check.job]?.result;
    const required = check.required(selected);
    let reason = null;

    if (!['success', 'failure', 'cancelled', 'skipped'].includes(status)) {
      reason = `${check.label} has invalid or missing result ${JSON.stringify(status)}`;
    } else if (status === 'failure' || status === 'cancelled') {
      reason = `${check.label} finished with ${status}`;
    } else if (required && status !== 'success') {
      reason = `${check.label} was required but finished with ${status}`;
    }

    return { ...check, reason, required, status };
  });

  return {
    evaluations,
    failures: evaluations.filter((evaluation) => evaluation.reason),
    passed: evaluations.every((evaluation) => !evaluation.reason),
  };
}

export function formatReleaseGateReport(result) {
  const lines = result.evaluations.map(
    ({ label, required, status }) =>
      `${label} => ${status} (${required ? 'required' : 'not selected'})`,
  );
  if (!result.passed) {
    lines.push('', 'release-gate failed');
    lines.push(...result.failures.map(({ reason }) => `- ${reason}`));
  }
  return `${lines.join('\n')}\n`;
}

function formatStepSummary(result) {
  const lines = ['## Release Gate Summary', ''];
  for (const { label, required, status } of result.evaluations) {
    lines.push(`- \`${label}\`: ${status} (${required ? 'required' : 'not selected'})`);
  }
  if (!result.passed) {
    lines.push('', '### Failures', '');
    lines.push(...result.failures.map(({ reason }) => `- ${reason}`));
  }
  return `${lines.join('\n')}\n`;
}

function readNeeds() {
  const raw = process.env.RELEASE_GATE_NEEDS_JSON;
  if (!raw) {
    throw new Error('RELEASE_GATE_NEEDS_JSON is required');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('RELEASE_GATE_NEEDS_JSON must contain valid JSON');
  }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function run() {
  const reportIndex = process.argv.indexOf('--report');
  const reportPath = reportIndex === -1 ? null : process.argv[reportIndex + 1];
  if (reportIndex !== -1 && !reportPath) {
    throw new Error('--report requires a file path');
  }

  const result = evaluateReleaseGateNeeds(readNeeds());
  const report = formatReleaseGateReport(result);
  process.stdout.write(report);
  if (reportPath) {
    writeFile(reportPath, report);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatStepSummary(result), 'utf8');
  }
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    const message = `release-gate could not run: ${error.message}`;
    const reportIndex = process.argv.indexOf('--report');
    const reportPath = reportIndex === -1 ? null : process.argv[reportIndex + 1];
    if (reportPath) {
      writeFile(reportPath, `${message}\n`);
    }
    console.error(message);
    process.exitCode = 1;
  }
}
