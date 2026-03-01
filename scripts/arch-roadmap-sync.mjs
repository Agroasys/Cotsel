#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const GATE_ISSUE_NUMBERS = [70, 71, 72];
const MATRIX_PATH_REFERENCE = "docs/runbooks/architecture-coverage-matrix.md";

function parseArgs(argv) {
  const args = {
    matrix: MATRIX_PATH_REFERENCE,
    repo: process.env.GITHUB_REPOSITORY || "Agroasys/Agroasys.Web3layer",
    out: "reports/governance/arch-roadmap-sync.json",
    patch: "reports/governance/arch-roadmap-sync.patch",
    cache: "reports/governance/arch-roadmap-sync-cache.json",
    offline: false,
    write: false,
    writeGateIssues: false,
    snapshotDate: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--offline") {
      args.offline = true;
      continue;
    }
    if (arg === "--write") {
      args.write = true;
      continue;
    }
    if (arg === "--write-gate-issues") {
      args.writeGateIssues = true;
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
    if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg === "--repo" && argv[index + 1]) {
      args.repo = argv[index + 1];
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
    if (arg.startsWith("--patch=")) {
      args.patch = arg.slice("--patch=".length);
      continue;
    }
    if (arg === "--patch" && argv[index + 1]) {
      args.patch = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--cache=")) {
      args.cache = arg.slice("--cache=".length);
      continue;
    }
    if (arg === "--cache" && argv[index + 1]) {
      args.cache = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--snapshot-date=")) {
      args.snapshotDate = arg.slice("--snapshot-date=".length);
      continue;
    }
    if (arg === "--snapshot-date" && argv[index + 1]) {
      args.snapshotDate = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (args.snapshotDate && !isIsoDate(args.snapshotDate)) {
    throw new Error(`invalid --snapshot-date value: ${args.snapshotDate}`);
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

function parseIssueNumbers(text) {
  const issues = [];
  const regex = /#(\d+)/gu;
  for (const match of String(text || "").matchAll(regex)) {
    issues.push(Number(match[1]));
  }
  return Array.from(new Set(issues)).sort((a, b) => a - b);
}

function formatRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function parseComponentTable(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const mappingIndex = lines.findIndex((line) => line.trim() === "## Component Mapping");
  if (mappingIndex < 0) {
    throw new Error('missing "## Component Mapping" section');
  }

  const snapshotIndex = lines.findIndex((line) => /^Snapshot date:\s*\d{4}-\d{2}-\d{2}$/.test(line.trim()));
  if (snapshotIndex < 0) {
    throw new Error("matrix is missing 'Snapshot date: YYYY-MM-DD'");
  }
  const snapshotDate = lines[snapshotIndex].trim().replace(/^Snapshot date:\s*/u, "");
  if (!isIsoDate(snapshotDate)) {
    throw new Error(`invalid matrix snapshot date: ${snapshotDate}`);
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
  if (!header || !separator || header.length !== separator.length) {
    throw new Error("invalid component mapping table header");
  }

  const rows = [];
  for (let index = tableStart + 2; index < lines.length; index += 1) {
    const values = parseRow(lines[index]);
    if (!values) {
      break;
    }
    if (values.length !== header.length) {
      throw new Error(`table row width mismatch at line ${index + 1}`);
    }

    const row = {
      line: index + 1,
      index,
      cells: values.slice(),
      Component: "",
      Status: "",
      LastRefreshed: "",
      RoadmapIssues: "",
      issueNumbers: [],
    };

    for (let column = 0; column < header.length; column += 1) {
      const name = header[column];
      const value = values[column];
      if (name === "Component") {
        row.Component = value;
      } else if (name === "Status") {
        row.Status = value;
      } else if (name === "Last Refreshed") {
        row.LastRefreshed = value;
      } else if (name === "Roadmap Issue(s)") {
        row.RoadmapIssues = value;
      }
    }
    row.issueNumbers = parseIssueNumbers(row.RoadmapIssues);
    rows.push(row);
  }

  const headerIndex = new Map();
  for (let index = 0; index < header.length; index += 1) {
    headerIndex.set(header[index], index);
  }

  return {
    lines,
    snapshotIndex,
    snapshotDate,
    header,
    headerIndex,
    rows,
  };
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
      "User-Agent": "agroasys-arch-roadmap-sync",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`github issue fetch failed (#${issueNumber}): http ${response.status} ${body}`);
  }

  const issue = await response.json();
  return {
    number: issue.number,
    state: issue.state,
    body: issue.body || "",
    url: issue.html_url,
  };
}

function saveIssueCache(cachePath, repo, issueMap) {
  const payload = {
    generatedAt: new Date().toISOString(),
    repo,
    issues: Array.from(issueMap.values()).sort((a, b) => a.number - b.number),
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function loadIssueCache(cachePath) {
  if (!fs.existsSync(cachePath)) {
    throw new Error(
      `offline cache not found: ${cachePath}. Run without --offline once to populate cache.`,
    );
  }
  const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const issues = new Map();

  if (Array.isArray(payload.issues)) {
    for (const issue of payload.issues) {
      issues.set(Number(issue.number), {
        number: Number(issue.number),
        state: String(issue.state || ""),
        body: String(issue.body || ""),
        url: String(issue.url || ""),
      });
    }
    return issues;
  }

  if (payload.issues && typeof payload.issues === "object") {
    for (const [key, issue] of Object.entries(payload.issues)) {
      issues.set(Number(key), {
        number: Number(key),
        state: String(issue.state || ""),
        body: String(issue.body || ""),
        url: String(issue.url || ""),
      });
    }
    return issues;
  }

  throw new Error(`invalid offline cache format: ${cachePath}`);
}

function parseLastSynchronizedDate(issueBody) {
  const match = String(issueBody || "").match(/Last synchronized:\s*(\d{4}-\d{2}-\d{2})/u);
  return match ? match[1] : null;
}

function syncGateIssueBody(issueBody, snapshotDate) {
  const current = String(issueBody || "");
  const targetLine = `Last synchronized: ${snapshotDate}`;
  let next = current;

  if (/Last synchronized:\s*\d{4}-\d{2}-\d{2}/u.test(next)) {
    next = next.replace(/Last synchronized:\s*\d{4}-\d{2}-\d{2}/u, targetLine);
  } else {
    const suffix = next.endsWith("\n") ? "" : "\n";
    next = `${next}${suffix}\n${targetLine}\n`;
  }

  if (!next.includes(MATRIX_PATH_REFERENCE)) {
    const suffix = next.endsWith("\n") ? "" : "\n";
    next = `${next}${suffix}\nSource matrix: ${MATRIX_PATH_REFERENCE}\n`;
  }

  return next;
}

async function patchIssueBody(repo, issueNumber, body, token) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agroasys-arch-roadmap-sync",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`failed to update gate issue #${issueNumber}: http ${response.status} ${text}`);
  }
}

function buildUnifiedDiff(originalPath, updatedContent) {
  const tempPath = path.join(os.tmpdir(), `arch-roadmap-sync-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(tempPath, updatedContent, "utf8");
  const diff = spawnSync("diff", ["-u", originalPath, tempPath], { encoding: "utf8" });
  fs.rmSync(tempPath, { force: true });

  if (diff.status === 0) {
    return "";
  }
  if (diff.status === 1) {
    return diff.stdout;
  }
  throw new Error(`failed to generate patch: ${diff.stderr || "diff exited unexpectedly"}`);
}

async function main() {
  const args = parseArgs(process.argv);

  const matrixPath = path.resolve(args.matrix);
  if (!fs.existsSync(matrixPath)) {
    throw new Error(`matrix file not found: ${matrixPath}`);
  }

  const matrixRaw = fs.readFileSync(matrixPath, "utf8");
  const hadTrailingNewline = matrixRaw.endsWith("\n");
  const table = parseComponentTable(matrixRaw);
  const statusIndex = table.headerIndex.get("Status");
  const lastRefreshedIndex = table.headerIndex.get("Last Refreshed");
  const percentIndex = table.headerIndex.get("% Complete");
  const remainingGapIndex = table.headerIndex.get("Remaining Gap");
  if (
    statusIndex === undefined ||
    lastRefreshedIndex === undefined ||
    percentIndex === undefined ||
    remainingGapIndex === undefined
  ) {
    throw new Error(
      "component mapping table is missing one or more required columns: Status, % Complete, Remaining Gap, Last Refreshed",
    );
  }

  const effectiveSnapshotDate = args.snapshotDate || table.snapshotDate;
  const token = getToken();
  const issueNumbers = new Set(GATE_ISSUE_NUMBERS);
  for (const row of table.rows) {
    for (const issueNumber of row.issueNumbers) {
      issueNumbers.add(issueNumber);
    }
  }

  let issueMap;
  if (args.offline) {
    issueMap = loadIssueCache(path.resolve(args.cache));
  } else {
    if (!token) {
      throw new Error("online mode requires GITHUB_TOKEN or GH_TOKEN (or use --offline)");
    }
    issueMap = new Map();
    const sortedIssues = Array.from(issueNumbers).sort((a, b) => a - b);
    for (const issueNumber of sortedIssues) {
      issueMap.set(issueNumber, await fetchIssue(args.repo, issueNumber, token));
    }
    saveIssueCache(path.resolve(args.cache), args.repo, issueMap);
  }

  const staleRows = [];
  const nextLines = table.lines.slice();
  for (const row of table.rows) {
    if (row.issueNumbers.length === 0) {
      continue;
    }

    const allClosed = row.issueNumbers.every((issueNumber) => issueMap.get(issueNumber)?.state === "closed");
    if (!allClosed || row.Status === "Done" || row.Status === "Out of Scope") {
      continue;
    }

    staleRows.push({
      line: row.line,
      component: row.Component,
      linkedIssues: row.issueNumbers.map((issueNumber) => `#${issueNumber}`),
      currentStatus: row.Status,
      suggestedStatus: "Done",
      currentPercentComplete: row.cells[percentIndex],
      suggestedPercentComplete: "100",
      reason: "all linked issues are closed",
    });

    row.cells[statusIndex] = "Done";
    row.cells[percentIndex] = "100";
    if (!String(row.cells[remainingGapIndex] || "").toLowerCase().startsWith("none")) {
      row.cells[remainingGapIndex] = "None (auto-synced from closed issues)";
    }
    row.cells[lastRefreshedIndex] = effectiveSnapshotDate;
    nextLines[row.index] = formatRow(row.cells);
  }

  const snapshotChanged = args.snapshotDate && args.snapshotDate !== table.snapshotDate;
  if (snapshotChanged) {
    nextLines[table.snapshotIndex] = `Snapshot date: ${args.snapshotDate}`;
  }

  const proposedMatrix = `${nextLines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
  const matrixChanged = proposedMatrix !== matrixRaw;
  const patchPath = path.resolve(args.patch);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(
    patchPath,
    matrixChanged ? buildUnifiedDiff(matrixPath, proposedMatrix) : "# No matrix content changes proposed.\n",
    "utf8",
  );

  if (args.write && matrixChanged) {
    fs.writeFileSync(matrixPath, proposedMatrix, "utf8");
  }

  const remainingStaleRows = args.write ? [] : staleRows;

  const gateIssueDrift = [];
  for (const issueNumber of GATE_ISSUE_NUMBERS) {
    const issue = issueMap.get(issueNumber);
    if (!issue) {
      gateIssueDrift.push({
        issue: `#${issueNumber}`,
        error: "issue could not be loaded",
        needsSync: true,
      });
      continue;
    }
    const lastSynchronized = parseLastSynchronizedDate(issue.body);
    const referencesMatrix = issue.body.includes(MATRIX_PATH_REFERENCE);
    const needsSync = lastSynchronized !== effectiveSnapshotDate || !referencesMatrix;
    gateIssueDrift.push({
      issue: `#${issueNumber}`,
      url: issue.url,
      currentLastSynchronized: lastSynchronized,
      expectedLastSynchronized: effectiveSnapshotDate,
      referencesMatrix,
      needsSync,
    });
  }

  const gateUpdatesApplied = [];
  if (args.writeGateIssues) {
    if (args.offline) {
      throw new Error("--write-gate-issues requires online mode");
    }
    if (!token) {
      throw new Error("--write-gate-issues requires GITHUB_TOKEN or GH_TOKEN");
    }

    for (const gate of gateIssueDrift) {
      if (!gate.needsSync) {
        continue;
      }
      const issueNumber = Number(gate.issue.replace("#", ""));
      const issue = issueMap.get(issueNumber);
      if (!issue) {
        continue;
      }
      const nextBody = syncGateIssueBody(issue.body, effectiveSnapshotDate);
      if (nextBody === issue.body) {
        continue;
      }
      await patchIssueBody(args.repo, issueNumber, nextBody, token);
      issue.body = nextBody;
      gateUpdatesApplied.push(gate.issue);
    }
  }

  const remainingGateIssueDrift = [];
  for (const issueNumber of GATE_ISSUE_NUMBERS) {
    const issue = issueMap.get(issueNumber);
    if (!issue) {
      remainingGateIssueDrift.push(`#${issueNumber}`);
      continue;
    }
    const lastSynchronized = parseLastSynchronizedDate(issue.body);
    const referencesMatrix = issue.body.includes(MATRIX_PATH_REFERENCE);
    if (lastSynchronized !== effectiveSnapshotDate || !referencesMatrix) {
      remainingGateIssueDrift.push(`#${issueNumber}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    repo: args.repo,
    matrixPath: args.matrix,
    cachePath: args.cache,
    patchPath: args.patch,
    offline: args.offline,
    snapshotDate: {
      current: table.snapshotDate,
      effective: effectiveSnapshotDate,
      override: args.snapshotDate,
    },
    matrix: {
      proposedChanges: matrixChanged,
      rowsUpdated: staleRows.length,
      snapshotDateChanged: Boolean(snapshotChanged),
      wroteChanges: Boolean(args.write && matrixChanged),
    },
    staleRows,
    remainingStaleRows,
    gateIssueDrift,
    gateUpdatesApplied,
    remainingGateIssueDrift,
    remediation: {
      writeMatrix: `GITHUB_TOKEN=\"$(gh auth token)\" node scripts/arch-roadmap-sync.mjs --repo \"${args.repo}\" --write`,
      writeGateIssues: `GITHUB_TOKEN=\"$(gh auth token)\" node scripts/arch-roadmap-sync.mjs --repo \"${args.repo}\" --write-gate-issues`,
    },
  };

  report.pass = remainingStaleRows.length === 0 && remainingGateIssueDrift.length === 0;

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Architecture-roadmap sync report: ${outPath}`);
  console.log(`Matrix patch: ${patchPath}`);
  console.log(`Rows requiring status sync: ${remainingStaleRows.length}`);
  console.log(`Gate issues requiring sync: ${remainingGateIssueDrift.length}`);

  if (!report.pass) {
    console.error("ERROR: architecture-roadmap drift remains.");
    if (remainingStaleRows.length > 0) {
      console.error(`ERROR: run ${report.remediation.writeMatrix}`);
    }
    if (remainingGateIssueDrift.length > 0) {
      console.error(`ERROR: run ${report.remediation.writeGateIssues}`);
    }
    process.exit(1);
  }

  console.log("Roadmap sync check passed");
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
