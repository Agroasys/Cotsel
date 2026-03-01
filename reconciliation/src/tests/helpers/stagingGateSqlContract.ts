import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type StagingGateSqlContract = {
  runSummarySql: string;
  driftSummarySql: string;
};

const RUN_SUMMARY_SQL_MARKER = `RUN_SUMMARY_SQL="$(cat <<'SQL'`;
const DRIFT_SUMMARY_SQL_MARKER = `DRIFT_SUMMARY_SQL="$(cat <<'SQL'`;

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n');
}

function extractHeredocSql(script: string, marker: string, label: string): string {
  const lines = normalizeLineEndings(script).split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === marker);
  if (startIndex < 0) {
    throw new Error(`Unable to find SQL marker for ${label}: ${marker}`);
  }

  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === 'SQL');
  if (endIndex < 0) {
    throw new Error(`Unable to find heredoc terminator for ${label}`);
  }

  const sql = lines.slice(startIndex + 1, endIndex).join('\n').trim();
  if (!sql) {
    throw new Error(`Extracted SQL for ${label} is empty`);
  }

  return sql;
}

export function loadStagingGateScript(): string {
  const gatePath = path.resolve(__dirname, '../../../../scripts/staging-e2e-real-gate.sh');
  return fs.readFileSync(gatePath, 'utf8');
}

export function loadStagingGateSqlContract(script = loadStagingGateScript()): StagingGateSqlContract {
  return {
    runSummarySql: extractHeredocSql(script, RUN_SUMMARY_SQL_MARKER, 'RUN_SUMMARY_SQL'),
    driftSummarySql: extractHeredocSql(script, DRIFT_SUMMARY_SQL_MARKER, 'DRIFT_SUMMARY_SQL'),
  };
}

export function sqlFingerprint(sql: string): string {
  return createHash('sha256').update(normalizeLineEndings(sql).trim()).digest('hex');
}
