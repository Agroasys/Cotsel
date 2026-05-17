#!/usr/bin/env bash
set -euo pipefail

# Cotsel VM deployment.
# Reads exclusively from .env.runtime — no other .env files may exist.
# Fails loudly and early on any misconfiguration.
#
# Usage:
#   scripts/deploy.sh               build images, start services, run gate
#   scripts/deploy.sh --skip-build  restart with current images (config-only re-deploy)
#
# See docs/runbooks/vm-deploy.md for the full VM setup procedure.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

PROFILE="staging-e2e-real"
RUNTIME_ENV=".env.runtime"
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    *)
      printf 'error: unknown argument: %s\n' "$arg" >&2
      printf 'usage: scripts/deploy.sh [--skip-build]\n' >&2
      exit 1
      ;;
  esac
done

log()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n\n' "$*" >&2; exit 1; }

# ── 1. Single source of truth enforcement ────────────────────────────────────
# .env.runtime must exist. No other .env files may exist alongside it —
# any stale file creates an ambiguity about which values are actually active.

log "Checking deployment environment..."

if [[ ! -f "$RUNTIME_ENV" ]]; then
  fail "$RUNTIME_ENV not found.

  Create it from the template and fill in every field:
    cp .env.runtime.example .env.runtime

  See docs/runbooks/vm-deploy.md for the complete procedure."
fi

for conflict in ".env" ".env.local" ".env.staging-e2e" ".env.staging-e2e-real"; do
  if [[ -e "$conflict" ]]; then
    fail "$conflict must not exist when deploying from $RUNTIME_ENV.
  It creates ambiguity about which values are active.
  Remove it:
    rm $conflict"
  fi
done

# Detect unfilled placeholder values written as KEY=<something>
unfilled="$(grep -cE '^[A-Z_]+=<[^>]+>' "$RUNTIME_ENV" 2>/dev/null || true)"
if [[ "${unfilled}" -gt 0 ]]; then
  fail "$RUNTIME_ENV contains ${unfilled} line(s) with unfilled placeholder values (e.g. KEY=<id>).
  Fill in every required field before deploying."
fi

note "$RUNTIME_ENV found — no conflicting env files — no unfilled placeholders"

# ── 2. Validate all required env vars ────────────────────────────────────────

log "Validating environment variables..."
scripts/validate-env.sh "$PROFILE"

# ── 3. Build container images ─────────────────────────────────────────────────

if [[ "$SKIP_BUILD" == "true" ]]; then
  log "Skipping image build (--skip-build)"
  note "Existing images will be used — rebuild without --skip-build if service code changed"
else
  log "Building container images (profile=$PROFILE)..."
  note "First build can take several minutes"
  scripts/docker-services.sh build "$PROFILE"
fi

# ── 4. Up → health → gate ────────────────────────────────────────────────────
# staging-e2e-real-gate.sh runs the full deployment sequence:
#   docker-services.sh up     — start all services in detached mode
#   docker-services.sh health — wait for every service to become healthy
#   indexer GraphQL readiness and schema parity check
#   indexer lag check (chain head vs indexed head, threshold enforced)
#   reconciliation once-run with drift classification snapshot
#   reorg/resync probe (pipeline restart + recovery verification)

log "Starting services and running deployment gate..."
scripts/staging-e2e-real-gate.sh

# ── 5. Final status ───────────────────────────────────────────────────────────

log "Running services:"
scripts/docker-services.sh ps "$PROFILE"

SEP="$(printf '─%.0s' {1..62})"
printf '\n%s\n' "$SEP"
printf 'Deployment complete\n'
printf '  profile:   %s\n' "$PROFILE"
printf '  env file:  %s\n' "$RUNTIME_ENV"
printf '\nOperational commands:\n'
printf '  scripts/docker-services.sh logs   %s [svc]   tail logs\n' "$PROFILE"
printf '  scripts/docker-services.sh health %s         re-check\n'  "$PROFILE"
printf '  scripts/docker-services.sh down   %s         stop + rm\n' "$PROFILE"
printf '%s\n' "$SEP"
