#!/usr/bin/env bash
set -euo pipefail

readonly aws_profile="${AWS_PROFILE:-agroasys}"
readonly aws_region="${AWS_REGION:-ap-south-1}"
readonly expected_account_id='655177116834'
readonly secret_id='/agroasys/staging/cotsel/database/indexer/runtime'
readonly expected_runtime_username='cotsel_indexer_app'
readonly reader_username='cotsel_indexer_reader'
readonly confirmation="${COTSEL_CONFIRM_INDEXER_READER_SECRET_UPDATE:-}"

if [[ "${aws_region}" != 'ap-south-1' ]]; then
  echo 'This operation supports only Cotsel staging in ap-south-1.' >&2
  exit 1
fi

if [[ "${-}" == *x* || -n "${BASH_XTRACEFD:-}" ]]; then
  echo 'Disable shell tracing before updating secret versions.' >&2
  exit 1
fi

for command_name in aws jq openssl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

caller_account="$({
  aws sts get-caller-identity \
    --profile "${aws_profile}" \
    --region "${aws_region}" \
    --query Account \
    --output text \
    --no-cli-pager
} 2>/dev/null)"

if [[ "${caller_account}" != "${expected_account_id}" ]]; then
  echo 'Use the Agroasys staging AWS account before updating the indexer secret.' >&2
  exit 1
fi

secret_json="$({
  aws secretsmanager get-secret-value \
    --profile "${aws_profile}" \
    --region "${aws_region}" \
    --secret-id "${secret_id}" \
    --query SecretString \
    --output text \
    --no-cli-pager
} 2>/dev/null)"

if ! jq -e \
  --arg expected_username "${expected_runtime_username}" \
  '.username == $expected_username and (.password | type == "string" and length > 0) and .database == "cotsel_indexer"' \
  <<<"${secret_json}" >/dev/null; then
  unset secret_json
  echo 'The current indexer runtime secret does not match the reviewed staging identity.' >&2
  exit 1
fi

has_reader_username="$(jq -r 'has("reader_username")' <<<"${secret_json}")"
has_reader_password="$(jq -r 'has("reader_password")' <<<"${secret_json}")"

if [[ "${has_reader_username}" != "${has_reader_password}" ]]; then
  unset secret_json
  echo 'The current indexer runtime secret has a partial reader credential. Inspect it before recovery.' >&2
  exit 1
fi

if [[ "${has_reader_username}" == 'true' ]]; then
  if jq -e \
    --arg reader_username "${reader_username}" \
    '.reader_username == $reader_username and (.reader_password | type == "string" and length >= 32)' \
    <<<"${secret_json}" >/dev/null; then
    unset secret_json
    echo "The reader credential already exists in ${secret_id}. No change was made."
    exit 0
  fi

  unset secret_json
  echo 'The existing reader credential does not match the reviewed identity. Refusing to replace it.' >&2
  exit 1
fi

if [[ "${confirmation}" != 'ADD_COTSEL_INDEXER_READER' ]]; then
  unset secret_json
  echo 'No change was made.' >&2
  echo 'Set COTSEL_CONFIRM_INDEXER_READER_SECRET_UPDATE=ADD_COTSEL_INDEXER_READER after the reviewed plan is approved.' >&2
  exit 1
fi

reader_password="$(openssl rand -hex 32)"
updated_secret_json="$(
  jq -c \
    --arg reader_username "${reader_username}" \
    --arg reader_password "${reader_password}" \
    '. + {reader_username: $reader_username, reader_password: $reader_password}' \
    <<<"${secret_json}"
)"

printf '%s' "${updated_secret_json}" | aws secretsmanager put-secret-value \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --secret-id "${secret_id}" \
  --secret-string file:///dev/stdin \
  --query VersionId \
  --output text \
  --no-cli-pager >/dev/null

unset reader_password updated_secret_json secret_json
echo "Added the cotsel_indexer_reader credential fields to ${secret_id}."
echo 'The existing runtime username, password, database, and previous secret version were retained.'
