#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/architecture-roadmap-consistency-check.mjs"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pass_matrix="$tmp_dir/matrix-pass.md"
fail_matrix="$tmp_dir/matrix-fail.md"
fail_matrix_last_refreshed="$tmp_dir/matrix-fail-last-refreshed.md"
fail_matrix_refresh_cadence="$tmp_dir/matrix-fail-refresh-cadence.md"

cat > "$pass_matrix" <<'MATRIX'
# Architecture Coverage Matrix

Snapshot date: 2026-02-28

## Component Mapping

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Example component | A | Done | 100 | #999 | `docs/example.md` | None for example scope | roadmap-maintainers | 2026-02-28 | weekly |

## Gate-to-Row Mapping
MATRIX

if ! node "$SCRIPT" --offline --matrix "$pass_matrix" --out "$tmp_dir/pass.json" >/dev/null; then
  echo "expected consistency checker to succeed for valid matrix" >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const outPath = process.argv[1];
  const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const requiredFields = ["pass", "errors", "warnings", "rowCount", "offline", "matrixPath"];
  for (const field of requiredFields) {
    if (!(field in report)) {
      throw new Error(`missing expected report field: ${field}`);
    }
  }
  if (report.pass !== true) {
    throw new Error("expected pass report to have pass=true");
  }
  if (!Array.isArray(report.errors) || report.errors.length !== 0) {
    throw new Error("expected pass report to have zero errors");
  }
' "$tmp_dir/pass.json"

cat > "$fail_matrix" <<'MATRIX'
# Architecture Coverage Matrix

Snapshot date: 2026-02-28

## Component Mapping

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Example component | A | Done | 100 | #999 | `docs/example.md` | None for example scope |  | 2026-02-28 | weekly |

## Gate-to-Row Mapping
MATRIX

if node "$SCRIPT" --offline --matrix "$fail_matrix" --out "$tmp_dir/fail.json" >/dev/null 2>&1; then
  echo "expected consistency checker to fail when Owner is empty" >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const outPath = process.argv[1];
  const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
  if (report.pass !== false) {
    throw new Error("expected fail report to have pass=false");
  }
  if (!Array.isArray(report.errors) || report.errors.length === 0) {
    throw new Error("expected fail report to contain at least one error");
  }
  const errorsText = report.errors.map(String).join(" ").toLowerCase();
  if (!errorsText.includes("owner")) {
    throw new Error("expected fail report errors to mention the Owner field");
  }
  if (!report.remediation || typeof report.remediation.writeMatrix !== "string") {
    throw new Error("expected remediation.writeMatrix in fail report");
  }
  if (!report.remediation || typeof report.remediation.writeGateIssues !== "string") {
    throw new Error("expected remediation.writeGateIssues in fail report");
  }
' "$tmp_dir/fail.json"

cat > "$fail_matrix_last_refreshed" <<'MATRIX'
# Architecture Coverage Matrix

Snapshot date: 2026-02-28

## Component Mapping

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Example component | A | Done | 100 | #999 | `docs/example.md` | None for example scope | roadmap-maintainers |  | weekly |

## Gate-to-Row Mapping
MATRIX

if node "$SCRIPT" --offline --matrix "$fail_matrix_last_refreshed" --out "$tmp_dir/fail-last-refreshed.json" >/dev/null 2>&1; then
  echo "expected consistency checker to fail when Last Refreshed is empty" >&2
  exit 1
fi

cat > "$fail_matrix_refresh_cadence" <<'MATRIX'
# Architecture Coverage Matrix

Snapshot date: 2026-02-28

## Component Mapping

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Example component | A | Done | 100 | #999 | `docs/example.md` | None for example scope | roadmap-maintainers | 2026-02-28 |  |

## Gate-to-Row Mapping
MATRIX

if node "$SCRIPT" --offline --matrix "$fail_matrix_refresh_cadence" --out "$tmp_dir/fail-refresh-cadence.json" >/dev/null 2>&1; then
  echo "expected consistency checker to fail when Refresh Cadence is empty" >&2
  exit 1
fi

echo "architecture-roadmap consistency checker offline validation: pass"
