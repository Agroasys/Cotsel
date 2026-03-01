#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const STATUS_VALUES = new Set(["Done", "In Progress", "Blocked", "Backlog", "Out of Scope"]);
const CADENCE_VALUES = new Set(["daily", "weekly", "biweekly", "monthly", "quarterly", "on-change"]);
const GATE_ISSUE_NUMBERS = [70, 71, 72];
const REQUIRED_COLUMNS = [
  "Component",
  "Milestone Target",
  "Status",
  "% Complete",
  "Roadmap Issue(s)",
  "Evidence",
  "Remaining Gap",
  "Owner",
  "Last Refreshed",
  "Refresh Cadence",
];

function parseArgs(argv) {
  const args = {
    matrix: "docs/runbooks/architecture-coverage-matrix.md",
    out: "reports/governance/architecture-roadmap-consistency.json",
    offline: false,
    repo: process.env.GITHUB_REPOSITORY || "Agroasys/Agroasys.Web3layer",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--offline") {
      args.offline = true;
      continue;
    }
    if (arg.startsWith("--matrix=")) {
      args.matrix = arg.slice("--matrix=".length);
      continue;
    }
    if (arg === "--matrix" && argv[index + 1]) {
      args.matrix = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      args.out = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--out" && argv[index + 1]) {
      args.out = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg === "--repo" && argv[index + 1]) {
      args.repo = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function parseRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((value) => value.trim());
}

function parseComponentTable(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const mappingIndex = lines.findIndex((line) => line.trim() === "## Component Mapping");
  if (mappingIndex < 0) {
    throw new Error('missing "## Component Mapping" section');
  }

  let tableStart = -1;
  for (let index = mappingIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith("|")) {
      tableStart = index;
      break;
    }
  }
  if (tableStart < 0 || tableStart + 1 >= lines.length) {
    throw new Error("component mapping table header not found");
  }

  const header = parseRow(lines[tableStart]);
  const separator = parseRow(lines[tableStart + 1]);
  if (!header || !separator) {
    throw new Error("invalid component mapping table header");
  }

  const rows = [];
  for (let index = tableStart + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) {
      break;
    }
    const values = parseRow(line);
    if (!values) {
      continue;
    }
    if (values.length !== header.length) {
      throw new Error(`table row width mismatch at line ${index + 1}`);
    }
    const row = {};
    for (let column = 0; column < header.length; column += 1) {
      row[header[column]] = values[column];
    }
    row._line = index + 1;
    rows.push(row);
  }

  return { header, rows };
}

function parseIssueNumbers(text) {
  const numbers = [];
  const regex = /#(\d+)/gu;
  for (const match of text.matchAll(regex)) {
    numbers.push(Number(match[1]));
  }
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

function getToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
}

async function fetchIssue(repo, issueNumber, token) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agroasys-arch-roadmap-consistency-check",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`github issue fetch failed (#${issueNumber}): http ${response.status} ${body}`);
  }

  return response.json();
}

function checkStatusConsistency(row, errors) {
  const status = row.Status;
  const percentRaw = row["% Complete"];
  const percent = Number.parseInt(percentRaw, 10);
  if (Number.isNaN(percent) || percent < 0 || percent > 100) {
    errors.push(`line ${row._line}: invalid % Complete value (${percentRaw})`);
    return;
  }

  const remainingGap = row["Remaining Gap"].toLowerCase();
  const noGap = remainingGap.startsWith("none");

  if (status === "Done") {
    if (percent !== 100) {
      errors.push(`line ${row._line}: Done row must have % Complete = 100`);
    }
    if (!noGap) {
      errors.push(`line ${row._line}: Done row must have Remaining Gap starting with "None"`);
    }
    return;
  }

  if (status === "Out of Scope") {
    if (row["Remaining Gap"].trim().length === 0) {
      errors.push(`line ${row._line}: Out of Scope row must explain scope boundary in Remaining Gap`);
    }
    return;
  }

  if (percent >= 100) {
    errors.push(`line ${row._line}: non-Done row cannot have % Complete >= 100`);
  }
  if (noGap) {
    errors.push(`line ${row._line}: non-Done row cannot declare Remaining Gap as none`);
  }
}

function validateMatrixRows(rows, errors) {
  for (const row of rows) {
    for (const column of REQUIRED_COLUMNS) {
      if (!Object.prototype.hasOwnProperty.call(row, column)) {
        continue;
      }
      if (String(row[column] || "").trim().length === 0) {
        errors.push(`line ${row._line}: required field is empty (${column})`);
      }
    }

    if (!STATUS_VALUES.has(row.Status)) {
      errors.push(`line ${row._line}: unsupported Status value (${row.Status})`);
    }

    if (!isIsoDate(row["Last Refreshed"])) {
      errors.push(`line ${row._line}: Last Refreshed must be YYYY-MM-DD (${row["Last Refreshed"]})`);
    }

    const cadence = row["Refresh Cadence"].toLowerCase();
    if (!CADENCE_VALUES.has(cadence)) {
      errors.push(`line ${row._line}: Refresh Cadence must be one of ${Array.from(CADENCE_VALUES).join(", ")} (${row["Refresh Cadence"]})`);
    }

    if (row.Evidence.trim().toLowerCase() === "none") {
      errors.push(`line ${row._line}: Evidence cannot be "None"`);
    }

    const issueNumbers = parseIssueNumbers(row["Roadmap Issue(s)"]);
    if (issueNumbers.length === 0) {
      errors.push(`line ${row._line}: Roadmap Issue(s) must include at least one #issue reference`);
    }

    checkStatusConsistency(row, errors);
  }
}

function parseLastSynchronizedDate(issueBody) {
  const match = issueBody.match(/Last synchronized:\s*(\d{4}-\d{2}-\d{2})/u);
  return match ? match[1] : null;
}

async function main() {
  const args = parseArgs(process.argv);

  const matrixPath = path.resolve(args.matrix);
  if (!fs.existsSync(matrixPath)) {
    throw new Error(`matrix file not found: ${matrixPath}`);
  }

  const markdown = fs.readFileSync(matrixPath, "utf8");
  const snapshotMatch = markdown.match(/^Snapshot date:\s*(\d{4}-\d{2}-\d{2})$/mu);
  if (!snapshotMatch) {
    throw new Error("matrix is missing 'Snapshot date: YYYY-MM-DD'");
  }
  const snapshotDate = snapshotMatch[1];
  if (!isIsoDate(snapshotDate)) {
    throw new Error(`invalid matrix snapshot date: ${snapshotDate}`);
  }

  const { header, rows } = parseComponentTable(markdown);

  const errors = [];
  const warnings = [];

  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      errors.push(`component mapping table missing required column: ${column}`);
    }
  }

  validateMatrixRows(rows, errors);

  const report = {
    generatedAt: new Date().toISOString(),
    repo: args.repo,
    matrixPath: args.matrix,
    snapshotDate,
    offline: args.offline,
    requiredColumns: REQUIRED_COLUMNS,
    rowCount: rows.length,
    errors,
    warnings,
    gateChecks: [],
    remediation: {
      writeMatrix: `GITHUB_TOKEN="$(gh auth token)" node scripts/arch-roadmap-sync.mjs --repo "${args.repo}" --write`,
      writeMatrixNormalized: `GITHUB_TOKEN="$(gh auth token)" node scripts/arch-roadmap-sync.mjs --repo "${args.repo}" --write --normalize-progress`,
      writeGateIssues: `GITHUB_TOKEN="$(gh auth token)" node scripts/arch-roadmap-sync.mjs --repo "${args.repo}" --write-gate-issues --apply`,
    },
  };

  if (!args.offline) {
    const token = getToken();
    if (!token) {
      errors.push("online mode requires GITHUB_TOKEN or GH_TOKEN (use --offline to skip issue-state checks)");
    } else {
      const issueNumbers = new Set(GATE_ISSUE_NUMBERS);
      for (const row of rows) {
        for (const issueNumber of parseIssueNumbers(row["Roadmap Issue(s)"])) {
          issueNumbers.add(issueNumber);
        }
      }

      const issueState = new Map();
      const sortedIssueNumbers = Array.from(issueNumbers).sort((a, b) => a - b);
      for (const issueNumber of sortedIssueNumbers) {
        const issue = await fetchIssue(args.repo, issueNumber, token);
        issueState.set(issueNumber, {
          number: issue.number,
          state: issue.state,
          body: issue.body || "",
          url: issue.html_url,
        });
      }

      for (const row of rows) {
        const linkedIssues = parseIssueNumbers(row["Roadmap Issue(s)"]);
        if (linkedIssues.length === 0) {
          continue;
        }

        const allClosed = linkedIssues.every((issueNumber) => issueState.get(issueNumber)?.state === "closed");
        if (allClosed && row.Status !== "Done" && row.Status !== "Out of Scope") {
          errors.push(
            `line ${row._line}: stale drift - all linked issues are closed (${linkedIssues.map((n) => `#${n}`).join(", ")}); expected Status=Done or Out of Scope, actual=${row.Status}`,
          );
        }
      }

      for (const gateIssueNumber of GATE_ISSUE_NUMBERS) {
        const gateIssue = issueState.get(gateIssueNumber);
        const gateResult = {
          issue: `#${gateIssueNumber}`,
          url: gateIssue?.url || null,
          lastSynchronized: null,
          matchesSnapshotDate: false,
          referencesMatrix: false,
        };

        if (!gateIssue) {
          errors.push(`gate issue #${gateIssueNumber} could not be fetched`);
          report.gateChecks.push(gateResult);
          continue;
        }

        const lastSynchronized = parseLastSynchronizedDate(gateIssue.body);
        gateResult.lastSynchronized = lastSynchronized;
        gateResult.matchesSnapshotDate = lastSynchronized === snapshotDate;
        gateResult.referencesMatrix = gateIssue.body.includes("docs/runbooks/architecture-coverage-matrix.md");

        if (!lastSynchronized) {
          errors.push(`gate issue #${gateIssueNumber} is missing 'Last synchronized: YYYY-MM-DD'`);
        } else if (lastSynchronized !== snapshotDate) {
          errors.push(
            `gate issue #${gateIssueNumber} last synchronized (${lastSynchronized}) does not match matrix snapshot date (${snapshotDate})`,
          );
        }

        if (!gateResult.referencesMatrix) {
          errors.push(`gate issue #${gateIssueNumber} does not reference architecture-coverage-matrix.md`);
        }

        report.gateChecks.push(gateResult);
      }
    }
  }

  report.pass = errors.length === 0;

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Architecture-roadmap consistency report: ${outPath}`);
  console.log(`Rows checked: ${rows.length}`);
  console.log(`Errors: ${errors.length}`);
  if (warnings.length > 0) {
    console.log(`Warnings: ${warnings.length}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ERROR: ${error}`);
    }
    console.error(`ERROR: remediation (matrix): ${report.remediation.writeMatrix}`);
    console.error(`ERROR: remediation (matrix+progress): ${report.remediation.writeMatrixNormalized}`);
    console.error(`ERROR: remediation (gate issues): ${report.remediation.writeGateIssues}`);
    process.exit(1);
  }

  console.log("Consistency check passed");
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
