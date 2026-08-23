#!/usr/bin/env bash
set -euo pipefail

readonly region="${AWS_REGION:-ap-south-1}"
readonly environment="${COTSEL_ENVIRONMENT:-staging}"
readonly account_id='655177116834'
readonly partial_recovery="${COTSEL_ALLOW_PARTIAL_RECOVERY:-false}"

if [[ "${environment}" != "staging" || "${region}" != "ap-south-1" ]]; then
  echo 'This bootstrap supports only Cotsel staging in ap-south-1.' >&2
  exit 1
fi

if [[ "${partial_recovery}" != 'false' && "${partial_recovery}" != 'true' ]]; then
  echo 'COTSEL_ALLOW_PARTIAL_RECOVERY must be true or false.' >&2
  exit 1
fi

if [[ "${-}" == *x* || -n "${BASH_XTRACEFD:-}" ]]; then
  echo 'Disable shell tracing before writing secret versions.' >&2
  exit 1
fi

if [[ "$(aws sts get-caller-identity --query Account --output text --no-cli-pager)" != "${account_id}" ]]; then
  echo 'Use the Agroasys staging AWS account before writing Cotsel secret versions.' >&2
  exit 1
fi

secret_has_current_version() {
  local secret_name="$1"
  local current_version

  current_version="$(aws secretsmanager list-secret-version-ids \
    --region "${region}" \
    --secret-id "${secret_name}" \
    --query "Versions[?contains(VersionStages, 'AWSCURRENT')].VersionId | [0]" \
    --output text \
    --no-cli-pager)"

  [[ "${current_version}" != "None" && -n "${current_version}" ]]
}

put_database_secret() {
  local secret_name="$1"
  local username="$2"
  local password

  password="$(openssl rand -hex 32)"
  printf '{"username":"%s","password":"%s"}' "${username}" "${password}" |
    aws secretsmanager put-secret-value \
      --region "${region}" \
      --secret-id "${secret_name}" \
      --secret-string file:///dev/stdin \
      --no-cli-pager >/dev/null
  unset password
  echo "Wrote initial version for ${secret_name}."
}

put_api_keys_secret() {
  local secret_name="$1"
  local identifier="$2"
  local secret

  secret="$(openssl rand -hex 32)"
  printf '[{"id":"%s","secret":"%s","active":true}]' "${identifier}" "${secret}" |
    aws secretsmanager put-secret-value \
      --region "${region}" \
      --secret-id "${secret_name}" \
      --secret-string file:///dev/stdin \
      --no-cli-pager >/dev/null
  unset secret
  echo "Wrote initial version for ${secret_name}."
}

readonly prefix="/agroasys/${environment}/cotsel"
readonly -a secret_names=(
  "${prefix}/database/ricardian/migration"
  "${prefix}/database/ricardian/runtime"
  "${prefix}/database/treasury/migration"
  "${prefix}/database/treasury/runtime"
  "${prefix}/gateway-to-ricardian-auth"
  "${prefix}/gateway-to-treasury-auth"
)
ensure_missing_secret() {
  local secret_name="$1"

  if ! secret_has_current_version "${secret_name}"; then
    return 0
  fi

  if [[ "${partial_recovery}" == 'true' ]]; then
    echo "Retaining existing current version for ${secret_name}."
    return 1
  fi

  echo "Refusing to replace the current version of ${secret_name}." >&2
  exit 1
}

missing_secret_count=0

for secret_name in "${secret_names[@]}"; do
  if ! secret_has_current_version "${secret_name}"; then
    ((missing_secret_count += 1))
  fi
done

if ((missing_secret_count == 0)); then
  echo 'All initial secret versions already exist. No changes made.'
  exit 0
fi

if ((missing_secret_count != ${#secret_names[@]})) && [[ "${partial_recovery}" != 'true' ]]; then
  echo 'A partial initial secret set exists. Inspect version metadata before recovery.' >&2
  echo 'Set COTSEL_ALLOW_PARTIAL_RECOVERY=true only to initialize missing values.' >&2
  exit 1
fi

if ensure_missing_secret "${prefix}/database/ricardian/migration"; then
  put_database_secret "${prefix}/database/ricardian/migration" 'cotsel_ricardian_migrator'
fi
if ensure_missing_secret "${prefix}/database/ricardian/runtime"; then
  put_database_secret "${prefix}/database/ricardian/runtime" 'cotsel_ricardian_runtime'
fi
if ensure_missing_secret "${prefix}/database/treasury/migration"; then
  put_database_secret "${prefix}/database/treasury/migration" 'cotsel_treasury_migrator'
fi
if ensure_missing_secret "${prefix}/database/treasury/runtime"; then
  put_database_secret "${prefix}/database/treasury/runtime" 'cotsel_treasury_runtime'
fi
if ensure_missing_secret "${prefix}/gateway-to-ricardian-auth"; then
  put_api_keys_secret "${prefix}/gateway-to-ricardian-auth" 'cotsel-gateway-ricardian-staging-v1'
fi
if ensure_missing_secret "${prefix}/gateway-to-treasury-auth"; then
  put_api_keys_secret "${prefix}/gateway-to-treasury-auth" 'cotsel-gateway-treasury-staging-v1'
fi
