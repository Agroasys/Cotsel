import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type StagingGateSqlContract = {
  runSummarySql: string;
  driftSummarySql: string;
};

type SqlBlockConfig = {
  variableName: string;
  label: string;
  requiredFragment: string;
};

const RUN_SUMMARY_SQL_BLOCK: SqlBlockConfig = {
  variableName: 'RUN_SUMMARY_SQL',
  label: 'RUN_SUMMARY_SQL',
  requiredFragment: 'FROM reconcile_runs',
};

const DRIFT_SUMMARY_SQL_BLOCK: SqlBlockConfig = {
  variableName: 'DRIFT_SUMMARY_SQL',
  label: 'DRIFT_SUMMARY_SQL',
  requiredFragment: 'FROM reconcile_drifts',
};

const SQL_HEREDOC_PATTERN = /cat\s*<<-?\s*'SQL'/;

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n');
}

function extractHeredocSql(script: string, config: SqlBlockConfig): string {
  const lines = normalizeLineEndings(script).split('\n');
  const startIndex = lines.findIndex(
    (line) => line.includes(config.variableName) && SQL_HEREDOC_PATTERN.test(line),
  );
  if (startIndex < 0) {
    throw new Error(
      `Unable to find SQL marker for ${config.label}: expected ${config.variableName} with cat <<'SQL'`,
    );
  }

  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === 'SQL');
  if (endIndex < 0) {
    throw new Error(`Unable to find heredoc terminator for ${config.label}`);
  }

  const sql = lines
    .slice(startIndex + 1, endIndex)
    .join('\n')
    .trim();
  if (!sql) {
    throw new Error(`Extracted SQL for ${config.label} is empty`);
  }
  if (!sql.includes(config.requiredFragment)) {
    throw new Error(
      `Extracted SQL for ${config.label} is missing expected fragment: ${config.requiredFragment}`,
    );
  }

  return sql;
}

export function loadStagingGateScript(): string {
  const gatePath = path.resolve(__dirname, '../../../../scripts/staging-e2e-real-gate.sh');
  return fs.readFileSync(gatePath, 'utf8');
}

export function loadStagingGateSqlContract(
  script = loadStagingGateScript(),
): StagingGateSqlContract {
  try {
    return {
      runSummarySql: extractHeredocSql(script, RUN_SUMMARY_SQL_BLOCK),
      driftSummarySql: extractHeredocSql(script, DRIFT_SUMMARY_SQL_BLOCK),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `staging-e2e-real gate script format changed, update markers in stagingGateSqlContract.ts. ${message}`,
    );
  }
}

export function sqlFingerprint(sql: string): string {
  return createHash('sha256').update(normalizeLineEndings(sql).trim()).digest('hex');
}
