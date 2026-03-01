#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/arch-roadmap-sync.mjs"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

matrix="$tmp_dir/matrix.md"
cache="$tmp_dir/cache.json"
report="$tmp_dir/sync-report.json"
patch="$tmp_dir/sync.patch"
report_write="$tmp_dir/sync-report-write.json"

cat > "$matrix" <<'MATRIX'
# Architecture Coverage Matrix

Snapshot date: 2026-03-01

## Component Mapping

| Component | Milestone Target | Status | % Complete | Roadmap Issue(s) | Evidence | Remaining Gap | Owner | Last Refreshed | Refresh Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Example component | A | In Progress | 40 | #101 | `docs/example.md` | Pending final closeout validation | roadmap-maintainers | 2026-02-25 | weekly |

## Gate-to-Row Mapping
MATRIX

cat > "$cache" <<'CACHE'
{
  "generatedAt": "2026-03-01T00:00:00.000Z",
  "repo": "Agroasys/Agroasys.Web3layer",
  "issues": [
    {
      "number": 70,
      "state": "open",
      "body": "Last synchronized: 2026-03-01\nSource matrix: docs/runbooks/architecture-coverage-matrix.md",
      "url": "https://github.com/Agroasys/Agroasys.Web3layer/issues/70"
    },
    {
      "number": 71,
      "state": "open",
      "body": "Last synchronized: 2026-03-01\nSource matrix: docs/runbooks/architecture-coverage-matrix.md",
      "url": "https://github.com/Agroasys/Agroasys.Web3layer/issues/71"
    },
    {
      "number": 72,
      "state": "open",
      "body": "Last synchronized: 2026-03-01\nSource matrix: docs/runbooks/architecture-coverage-matrix.md",
      "url": "https://github.com/Agroasys/Agroasys.Web3layer/issues/72"
    },
    {
      "number": 101,
      "state": "closed",
      "body": "Closed issue",
      "url": "https://github.com/Agroasys/Agroasys.Web3layer/issues/101"
    }
  ]
}
CACHE

if node "$SCRIPT" --offline --matrix "$matrix" --cache "$cache" --out "$report" --patch "$patch" >/dev/null 2>&1; then
  echo "expected sync helper to fail in check mode when stale rows exist" >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (report.pass !== false) {
    throw new Error("expected check-mode report.pass=false");
  }
  if (!Array.isArray(report.staleRows) || report.staleRows.length !== 1) {
    throw new Error("expected one stale row recommendation");
  }
  if (!Array.isArray(report.remainingGateIssueDrift) || report.remainingGateIssueDrift.length !== 0) {
    throw new Error("expected zero remaining gate issue drift from cache fixture");
  }
  if (!report.remediation || !report.remediation.writeMatrix) {
    throw new Error("expected remediation.writeMatrix command");
  }
' "$report"

if ! grep -q "None (auto-synced from closed issues)" "$patch"; then
  echo "expected patch to include deterministic Remaining Gap update" >&2
  exit 1
fi

if ! node "$SCRIPT" --offline --write --matrix "$matrix" --cache "$cache" --out "$report_write" --patch "$patch" >/dev/null 2>&1; then
  echo "expected sync helper write mode to apply row updates cleanly" >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (report.pass !== true) {
    throw new Error("expected write-mode report.pass=true after applying sync updates");
  }
  if (!report.matrix || report.matrix.wroteChanges !== true) {
    throw new Error("expected matrix.wroteChanges=true in write mode");
  }
  if (!Array.isArray(report.remainingStaleRows) || report.remainingStaleRows.length !== 0) {
    throw new Error("expected no remaining stale rows after write mode");
  }
' "$report_write"

if ! grep -q "| Example component | A | Done | 100 | #101 | \`docs/example.md\` | None (auto-synced from closed issues) | roadmap-maintainers | 2026-03-01 | weekly |" "$matrix"; then
  echo "expected matrix row to be rewritten to Done/100 with refreshed date" >&2
  exit 1
fi

echo "architecture-roadmap sync helper offline validation: pass"
