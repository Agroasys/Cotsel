#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/dashboard-live-parity-gate.sh"

make_fake_git() {
  local file="$1"
  cat > "$file" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
  case "${2:-}" in
    *Cotsel-Dash) echo "dash-sha-123" ;;
    *) echo "cotsel-sha-456" ;;
  esac
  exit 0
fi

echo "unexpected git invocation: $*" >&2
exit 1
EOF
  chmod +x "$file"
}

make_fake_npm() {
  local file="$1"
  cat > "$file" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'cwd=%s cmd=npm %s\n' "$PWD" "$*" >> "${FAKE_LOG_FILE:?}"

if [[ "${1:-}" == "run" && "${2:-}" == "dashboard:parity:session" ]]; then
  cat > "${DASHBOARD_SMOKE_SESSION_OUTPUT_FILE:?}" <<JSON
{"sessionId":"session-123"}
JSON
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "dashboard:parity:gate" ]]; then
  if [[ "${FAKE_FAIL_STEP:-}" == "dashboard-parity-gate" ]]; then
    exit 27
  fi
  exit 0
fi

if [[ "${1:-}" == "ci" ]]; then
  if [[ "${FAKE_FAIL_STEP:-}" == "dash-repo-prepare" ]]; then
    exit 31
  fi
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "test:e2e:live" ]]; then
  if [[ "${FAKE_FAIL_STEP:-}" == "dash-live-suite" ]]; then
    exit 32
  fi
  exit 0
fi

echo "unexpected npm invocation: $*" >&2
exit 1
EOF
  chmod +x "$file"
}

make_fake_npx() {
  local file="$1"
  cat > "$file" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'cwd=%s cmd=npx %s\n' "$PWD" "$*" >> "${FAKE_LOG_FILE:?}"

if [[ "${1:-}" == "hardhat" ]]; then
  if [[ "${FAKE_FAIL_STEP:-}" == "escrow-deploy" ]]; then
    exit 21
  fi
  exit 0
fi

if [[ "${1:-}" == "playwright" && "${2:-}" == "install" ]]; then
  if [[ "${FAKE_FAIL_STEP:-}" == "dash-repo-prepare" ]]; then
    exit 33
  fi
  exit 0
fi

echo "unexpected npx invocation: $*" >&2
exit 1
EOF
  chmod +x "$file"
}

make_fake_validate_env() {
  local file="$1"
  cat > "$file" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cmd=validate-env %s\n' "$*" >> "${FAKE_LOG_FILE:?}"
if [[ "${FAKE_FAIL_STEP:-}" == "validate-env" ]]; then
  exit 11
fi
EOF
  chmod +x "$file"
}

make_fake_docker_services() {
  local file="$1"
  cat > "$file" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cmd=docker-services %s\n' "$*" >> "${FAKE_LOG_FILE:?}"

action="${1:-}"
profile="${2:-}"

case "$action:$profile" in
  build:local-dev|up:local-dev|down:local-dev)
    exit 0
    ;;
  health:local-dev)
    if [[ "${FAKE_FAIL_STEP:-}" == "local-dev-health" ]]; then
      exit 19
    fi
    exit 0
    ;;
esac

echo "unexpected docker-services invocation: $*" >&2
exit 1
EOF
  chmod +x "$file"
}

run_case() {
  local name="$1"
  local fail_step="${2:-}"
  local fixture_mode="${3:-dashboard-parity}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  mkdir -p "$tmp_dir/scripts" "$tmp_dir/contracts" "$tmp_dir/Cotsel-Dash" "$tmp_dir/mock-bin"
  cp "$SCRIPT" "$tmp_dir/scripts/dashboard-live-parity-gate.sh"
  make_fake_git "$tmp_dir/mock-bin/git"
  make_fake_npm "$tmp_dir/mock-bin/npm"
  make_fake_npx "$tmp_dir/mock-bin/npx"
  make_fake_validate_env "$tmp_dir/scripts/validate-env.sh"
  make_fake_docker_services "$tmp_dir/scripts/docker-services.sh"

  cat > "$tmp_dir/.env" <<'EOF'
ORACLE_PRIVATE_KEY=0x0123456789012345678901234567890123456789012345678901234567890123
EOF

  cat > "$tmp_dir/.env.local" <<EOF
LOCAL_DEV_INDEXER_FIXTURE_MODE=${fixture_mode}
EOF

  cat > "$tmp_dir/Cotsel-Dash/package.json" <<'EOF'
{
  "name": "cotsel-dash",
  "scripts": {
    "test:e2e:live": "echo live"
  }
}
EOF

  local log_file="$tmp_dir/fake.log"
  local exit_code=0
  (
    cd "$tmp_dir"
    PATH="$tmp_dir/mock-bin:$PATH" \
      FAKE_LOG_FILE="$log_file" \
      FAKE_FAIL_STEP="$fail_step" \
      DASHBOARD_LIVE_SUITE_REPO_DIR="$tmp_dir/Cotsel-Dash" \
      bash ./scripts/dashboard-live-parity-gate.sh >/tmp/"${name}".out 2>/tmp/"${name}".err
  ) || exit_code=$?

  echo "$tmp_dir|$exit_code"
}

success_result="$(run_case success local-dev-health dashboard-parity)"
success_dir="${success_result%|*}"
success_exit="${success_result##*|}"
if [[ "$success_exit" -ne 0 ]]; then
  echo "expected success case to pass" >&2
  exit 1
fi

node - "$success_dir/reports/dashboard-parity/live-parity-gate.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error("expected report.ok true");
if (report.summary.wholeProfileHealth.status !== "fail") throw new Error("expected advisory whole-profile health failure");
if (report.summary.wholeProfileHealth.advisory !== true) throw new Error("expected advisory whole-profile health");
if (report.summary.dashboardParityGate !== "pass") throw new Error("expected parity gate pass");
if (report.summary.dashLiveSuite !== "pass") throw new Error("expected dash live suite pass");
NODE

parity_fail_result="$(run_case parity-fail dashboard-parity-gate dashboard-parity)"
parity_fail_dir="${parity_fail_result%|*}"
parity_fail_exit="${parity_fail_result##*|}"
if [[ "$parity_fail_exit" -eq 0 ]]; then
  echo "expected dashboard parity gate failure to exit non-zero" >&2
  exit 1
fi

node - "$parity_fail_dir/reports/dashboard-parity/live-parity-gate.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== false) throw new Error("expected report.ok false");
if (report.blockingFailure.classification !== "dashboard_parity_gate_failed") {
  throw new Error(`unexpected blocking classification: ${report.blockingFailure.classification}`);
}
if (report.summary.dashLiveSuite !== "not_run") throw new Error("expected dash live suite not_run");
NODE

env_fail_result="$(run_case env-fail "" empty)"
env_fail_dir="${env_fail_result%|*}"
env_fail_exit="${env_fail_result##*|}"
if [[ "$env_fail_exit" -eq 0 ]]; then
  echo "expected invalid fixture mode to fail" >&2
  exit 1
fi

node - "$env_fail_dir/reports/dashboard-parity/live-parity-gate.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.blockingFailure.classification !== "env_invalid") {
  throw new Error(`unexpected blocking classification: ${report.blockingFailure.classification}`);
}
if (report.statuses.validateEnv !== "not_run") throw new Error("expected validateEnv not_run on fixture failure");
NODE

echo "dashboard live parity gate report behavior: pass"
