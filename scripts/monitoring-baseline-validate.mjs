#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const EXPECTED_SERVICES = [
  "oracle",
  "indexer",
  "reconciliation",
  "treasury",
  "ricardian",
  "notifications",
];

const REQUIRED_HEADINGS = [
  "Scope and Non-goals",
  "Service Reality Mapping",
  "Service SLO Baseline",
  "Alert Matrix",
  "Severity Routing and Escalation Policy",
  "Suppression Policy",
  "Incident Evidence Checklist",
  "Evidence Capture Commands",
  "Staging-E2E-Real Release Evidence",
];

function readArg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function sectionByHeading(markdown, headingText) {
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(headingText)}\\s*$`, "m");
  const match = headingRe.exec(markdown);
  if (!match || typeof match.index !== "number") {
    return null;
  }
  const start = match.index + match[0].length;
  const remainder = markdown.slice(start);
  const nextHeadingOffset = remainder.search(/^##\s+/m);
  const end = nextHeadingOffset === -1 ? markdown.length : start + nextHeadingOffset;
  return markdown.slice(start, end).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMarkdownTable(sectionText) {
  const lines = sectionText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const tableStart = lines.findIndex((line) => line.startsWith("|"));
  if (tableStart === -1) {
    return { headers: [], rows: [] };
  }

  const tableLines = [];
  for (let i = tableStart; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("|")) {
      break;
    }
    tableLines.push(line);
  }

  if (tableLines.length < 2) {
    return { headers: [], rows: [] };
  }

  const toCells = (line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

  const headers = toCells(tableLines[0]);
  const rows = tableLines
    .slice(2)
    .map(toCells)
    .filter((cells) => cells.some((cell) => cell.length > 0))
    .map((cells) => {
      const row = {};
      headers.forEach((header, idx) => {
        row[header] = cells[idx] ?? "";
      });
      return row;
    });

  return { headers, rows };
}

function parseDurationHours(value) {
  const match = /^([0-9]+)h$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function main() {
  const runbookPathArg = readArg("--runbook", "docs/runbooks/monitoring-alerting-baseline.md");
  const outPathArg = readArg("--out", null);
  const runbookPath = path.resolve(process.cwd(), runbookPathArg);

  const errors = [];
  const warnings = [];

  if (!fs.existsSync(runbookPath)) {
    errors.push(`Runbook not found: ${runbookPath}`);
    return finish({ runbookPath, errors, warnings, outPathArg });
  }

  const markdown = fs.readFileSync(runbookPath, "utf8");

  for (const heading of REQUIRED_HEADINGS) {
    const section = sectionByHeading(markdown, heading);
    if (!section) {
      errors.push(`Missing required heading: ## ${heading}`);
    }
  }

  const mappingSection = sectionByHeading(markdown, "Service Reality Mapping") || "";
  const servicesInScope = Array.from(
    mappingSection.matchAll(/^- `([^`]+)`$/gm),
    (match) => match[1].trim(),
  );
  const missingServices = EXPECTED_SERVICES.filter((service) => !servicesInScope.includes(service));
  const unexpectedServices = servicesInScope.filter((service) => !EXPECTED_SERVICES.includes(service));
  if (missingServices.length > 0) {
    errors.push(`Service list missing: ${missingServices.join(", ")}`);
  }
  if (unexpectedServices.length > 0) {
    errors.push(`Service list has unsupported entries: ${unexpectedServices.join(", ")}`);
  }

  const sloSection = sectionByHeading(markdown, "Service SLO Baseline") || "";
  const sloTable = parseMarkdownTable(sloSection);
  if (sloTable.rows.length === 0) {
    errors.push("Service SLO Baseline table is missing or empty.");
  } else {
    const missingSloRows = EXPECTED_SERVICES.filter(
      (service) => !sloTable.rows.some((row) => row["Service"] === service),
    );
    if (missingSloRows.length > 0) {
      errors.push(`SLO table missing service rows: ${missingSloRows.join(", ")}`);
    }
  }

  const alertSection = sectionByHeading(markdown, "Alert Matrix") || "";
  const alertTable = parseMarkdownTable(alertSection);
  if (alertTable.rows.length === 0) {
    errors.push("Alert Matrix table is missing or empty.");
  } else {
    const requiredAlertColumns = ["Service", "Severity", "Escalation Owner", "Evidence Command"];
    for (const column of requiredAlertColumns) {
      if (!alertTable.headers.includes(column)) {
        errors.push(`Alert Matrix missing required column: ${column}`);
      }
    }

    const servicesCovered = new Set();
    let criticalRows = 0;

    for (const row of alertTable.rows) {
      const service = row["Service"] || "";
      const severity = (row["Severity"] || "").toUpperCase();
      const escalationOwner = (row["Escalation Owner"] || "").trim();
      const evidenceCommand = (row["Evidence Command"] || "").trim();

      if (!EXPECTED_SERVICES.includes(service)) {
        errors.push(`Alert Matrix has unsupported service entry: "${service}"`);
      } else {
        servicesCovered.add(service);
      }

      if (severity === "CRITICAL") {
        criticalRows += 1;
        if (!escalationOwner || escalationOwner === "-") {
          errors.push(`CRITICAL alert row missing escalation owner for service "${service}"`);
        }
        if (!evidenceCommand || evidenceCommand === "-") {
          errors.push(`CRITICAL alert row missing evidence command for service "${service}"`);
        }
      }
    }

    if (criticalRows === 0) {
      errors.push("Alert Matrix must include at least one CRITICAL alert row.");
    }

    const uncoveredServices = EXPECTED_SERVICES.filter((service) => !servicesCovered.has(service));
    if (uncoveredServices.length > 0) {
      warnings.push(`Alert Matrix has no direct alert row for: ${uncoveredServices.join(", ")}`);
    }
  }

  const suppressionSection = sectionByHeading(markdown, "Suppression Policy") || "";
  const maxWindowMatch = suppressionSection.match(/`max_suppression_window`:\s*`([^`]+)`/);
  const approverMatch = suppressionSection.match(/`suppression_approver_role`:\s*`([^`]+)`/);
  const auditRequiredMatch = suppressionSection.match(/`suppression_audit_note_required`:\s*`([^`]+)`/);

  if (!maxWindowMatch) {
    errors.push("Suppression Policy missing `max_suppression_window` field.");
  } else {
    const hours = parseDurationHours(maxWindowMatch[1]);
    if (hours === null || hours <= 0 || hours > 2) {
      errors.push("`max_suppression_window` must be a positive duration in hours up to 2h (example: `2h`).");
    }
  }

  if (!approverMatch || approverMatch[1].trim().length === 0) {
    errors.push("Suppression Policy missing `suppression_approver_role` value.");
  }

  if (!auditRequiredMatch) {
    errors.push("Suppression Policy missing `suppression_audit_note_required` field.");
  } else if (auditRequiredMatch[1].trim().toLowerCase() !== "true") {
    errors.push("`suppression_audit_note_required` must be `true`.");
  }

  return finish({
    runbookPath,
    errors,
    warnings,
    outPathArg,
    servicesInScope,
    sloRowCount: sloTable.rows.length,
    alertRowCount: alertTable.rows.length,
  });
}

function finish({
  runbookPath,
  errors,
  warnings,
  outPathArg,
  servicesInScope = [],
  sloRowCount = 0,
  alertRowCount = 0,
}) {
  const report = {
    pass: errors.length === 0,
    checkedAt: new Date().toISOString(),
    runbookPath,
    servicesInScope,
    sloRowCount,
    alertRowCount,
    warnings,
    errors,
  };

  if (outPathArg) {
    const outPath = path.resolve(process.cwd(), outPathArg);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ERROR: ${error}`);
    }
    for (const warning of warnings) {
      console.error(`WARN: ${warning}`);
    }
    process.exit(1);
  }

  for (const warning of warnings) {
    console.log(`WARN: ${warning}`);
  }
  console.log(
    `PASS: monitoring baseline validated (${servicesInScope.length} services, ${alertRowCount} alert rows).`,
  );
  process.exit(0);
}

main();
