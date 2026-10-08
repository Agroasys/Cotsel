import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeScan(document, kind) {
  if (document?.SchemaVersion !== 2 || !Array.isArray(document.Results)) {
    throw new Error(`${kind}: missing or invalid Trivy report`);
  }
  const findings = document.Results.flatMap((result) =>
    (kind === 'secrets' ? (result.Secrets ?? []) : (result.Misconfigurations ?? [])).map(
      (finding) => ({
        target: result.Target,
        id: finding.RuleID ?? finding.ID,
        severity: finding.Severity,
        startLine: finding.StartLine ?? finding.CauseMetadata?.StartLine ?? null,
        endLine: finding.EndLine ?? finding.CauseMetadata?.EndLine ?? null,
      }),
    ),
  );
  return { kind, findings };
}

export function buildScanEvidence({ reports, outcomes, sourceCommit }) {
  const violations = [];
  const scans = Object.entries(reports).map(([kind, raw]) => {
    try {
      const summary = summarizeScan(JSON.parse(raw), kind);
      const prohibited = summary.findings.filter(
        (finding) => kind === 'secrets' || ['HIGH', 'CRITICAL'].includes(finding.severity),
      );
      if (prohibited.length > 0) violations.push(`${kind}: ${prohibited.length} blocking findings`);
      return { ...summary, reportSha256: createHash('sha256').update(raw).digest('hex') };
    } catch {
      violations.push(`${kind}: missing or invalid report`);
      return { kind, findings: [], reportSha256: null };
    }
  });
  for (const kind of ['secrets', 'iac', 'seeded']) {
    if (outcomes[kind] !== 'success') violations.push(`${kind}: scanner step did not succeed`);
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '')) violations.push('missing source commit');
  return { sourceCommit, outcomes, scans, violations, passed: violations.length === 0 };
}

function run() {
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const result = buildScanEvidence({
    reports: {
      secrets: read('/tmp/cotsel-secret-scan.json'),
      iac: read('/tmp/cotsel-iac-scan.json'),
    },
    outcomes: {
      secrets: process.env.SECRET_SCAN_OUTCOME,
      iac: process.env.IAC_SCAN_OUTCOME,
      seeded: process.env.SEEDED_SCAN_OUTCOME,
    },
    sourceCommit: process.env.GITHUB_SHA,
  });
  fs.mkdirSync('ci-reports', { recursive: true });
  fs.writeFileSync('ci-reports/repository-security.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Repository security ${result.passed ? 'passed' : 'failed'}.`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
