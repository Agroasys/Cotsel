#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/validate-env.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cp "$ROOT_DIR/.env.example" "$tmp_dir/.env"
cp "$ROOT_DIR/.env.staging-e2e-real.example" "$tmp_dir/.env.staging-e2e-real"

python3 - <<'PY' "$tmp_dir/.env"
from pathlib import Path
import sys

path = Path(sys.argv[1])
lines = path.read_text().splitlines()
path.write_text("\n".join(line for line in lines if not line.startswith("GATEWAY_DB_NAME=")) + "\n")
PY

if (
  cd "$tmp_dir" &&
  bash "$SCRIPT" staging-e2e-real >/tmp/validate-env-gateway-db.out 2>/tmp/validate-env-gateway-db.err
); then
  echo "expected validate-env.sh to fail when GATEWAY_DB_NAME is missing" >&2
  exit 1
fi

if ! grep -q 'GATEWAY_DB_NAME' /tmp/validate-env-gateway-db.err; then
  echo "expected missing GATEWAY_DB_NAME error output" >&2
  cat /tmp/validate-env-gateway-db.err >&2
  exit 1
fi

echo 'GATEWAY_DB_NAME=agroasys_gateway' >> "$tmp_dir/.env"

(
  cd "$tmp_dir" &&
  bash "$SCRIPT" staging-e2e-real >/tmp/validate-env-gateway-db.out 2>/tmp/validate-env-gateway-db.err
)

if ! grep -q 'env validation passed for profile: staging-e2e-real' /tmp/validate-env-gateway-db.out; then
  echo "expected validate-env.sh to pass once GATEWAY_DB_NAME is restored" >&2
  cat /tmp/validate-env-gateway-db.out >&2
  cat /tmp/validate-env-gateway-db.err >&2
  exit 1
fi

echo "validate-env gateway db guard: pass"
