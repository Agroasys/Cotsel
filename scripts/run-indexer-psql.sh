#!/usr/bin/env bash
set -euo pipefail

readonly password_env="${1:?password environment variable name is required}"
readonly username="${2:?database username is required}"
readonly database="${3:?database name is required}"
shift 3

case "${password_env}" in
  INDEXER_DB_RUNTIME_PASSWORD | INDEXER_DB_READER_PASSWORD) ;;
  *)
    echo 'Only indexer runtime or reader credentials are supported.' >&2
    exit 1
    ;;
esac

if [[ "${-}" == *x* || -n "${BASH_XTRACEFD:-}" ]]; then
  echo 'Disable shell tracing before using database role credentials.' >&2
  exit 1
fi

if [[ ! "${username}" =~ ^[A-Za-z0-9_-]+$ || ! "${database}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo 'Database username and name must contain only letters, digits, underscores, or hyphens.' >&2
  exit 1
fi

readonly password="${!password_env:-}"
if [[ -z "${password}" ]]; then
  echo "${password_env} is required." >&2
  exit 1
fi

printf '%s\n' "${password}" | docker compose \
  -f "${COTSEL_COMPOSE_FILE:-docker-compose.services.yml}" \
  --profile "${COTSEL_COMPOSE_PROFILE:-runtime}" \
  exec -T postgres sh -ceu '
    IFS= read -r PGPASSWORD
    export PGPASSWORD
    exec psql "$@"
  ' sh -h postgres -U "${username}" -d "${database}" "$@"
