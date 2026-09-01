#!/bin/sh
set -eu

# This script runs inside the digest-pinned Postgres verifier image. It emits
# only catalog facts, exact row counts, and SHA-256 fingerprints. It never
# emits row values, credentials, or a connection string.

: "${COTSEL_POSTGRES_HOST:?COTSEL_POSTGRES_HOST is required}"

: "${AUTH_RUNTIME_USERNAME:?AUTH_RUNTIME_USERNAME is required}"
: "${AUTH_RUNTIME_PASSWORD:?AUTH_RUNTIME_PASSWORD is required}"
: "${GATEWAY_RUNTIME_USERNAME:?GATEWAY_RUNTIME_USERNAME is required}"
: "${GATEWAY_RUNTIME_PASSWORD:?GATEWAY_RUNTIME_PASSWORD is required}"
: "${INDEXER_RUNTIME_USERNAME:?INDEXER_RUNTIME_USERNAME is required}"
: "${INDEXER_RUNTIME_PASSWORD:?INDEXER_RUNTIME_PASSWORD is required}"
: "${ORACLE_RUNTIME_USERNAME:?ORACLE_RUNTIME_USERNAME is required}"
: "${ORACLE_RUNTIME_PASSWORD:?ORACLE_RUNTIME_PASSWORD is required}"
: "${RECONCILIATION_RUNTIME_USERNAME:?RECONCILIATION_RUNTIME_USERNAME is required}"
: "${RECONCILIATION_RUNTIME_PASSWORD:?RECONCILIATION_RUNTIME_PASSWORD is required}"
: "${RICARDIAN_RUNTIME_USERNAME:?RICARDIAN_RUNTIME_USERNAME is required}"
: "${RICARDIAN_RUNTIME_PASSWORD:?RICARDIAN_RUNTIME_PASSWORD is required}"
: "${TREASURY_RUNTIME_USERNAME:?TREASURY_RUNTIME_USERNAME is required}"
: "${TREASURY_RUNTIME_PASSWORD:?TREASURY_RUNTIME_PASSWORD is required}"

export PGHOST="${COTSEL_POSTGRES_HOST}"
export PGPORT="${COTSEL_POSTGRES_PORT:-5432}"
export PGSSLMODE='verify-full'
export PGSSLROOTCERT='/tmp/aws-rds-global-bundle.pem'

umask 077
manifest_files=''
cleanup() {
  for manifest_file in ${manifest_files}; do
    rm -f "${manifest_file}"
  done
  rm -f "${PGSSLROOTCERT}"
}
trap cleanup EXIT HUP INT TERM

wget --quiet -O "${PGSSLROOTCERT}" 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'
printf '%s  %s\n' 'e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3' "${PGSSLROOTCERT}" | sha256sum -c -s

sha256_stream() {
  sha256sum | awk '{print $1}'
}

collect_database() {
  service_name="${1}"
  database_name="${2}"
  runtime_username="${3}"
  runtime_password="${4}"
  manifest_file="/tmp/cotsel-recovery-${service_name}-$$.manifest"
  table_list_file="/tmp/cotsel-recovery-${service_name}-$$.tables"
  sequence_list_file="/tmp/cotsel-recovery-${service_name}-$$.sequences"
  manifest_files="${manifest_files} ${manifest_file} ${table_list_file} ${sequence_list_file}"

  export PGUSER="${runtime_username}"
  export PGPASSWORD="${runtime_password}"
  export PGOPTIONS="-c app.service_name=${service_name} -c app.connection_role=runtime -c app.runtime_db_user=${runtime_username}"

  server_version="$(psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align -c "SELECT current_setting('server_version_num')")"

  schema_sha256="$(
    pg_dump \
      --dbname "${database_name}" \
      --schema-only \
      --no-owner \
      --no-privileges \
      --no-comments \
      --restrict-key='cotselrecovery' \
      | sha256_stream
  )"

  access_sha256="$(
    psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' <<'SQL' \
      | sha256_stream
SELECT record_type, object_name, detail
FROM (
  SELECT
    'current_role'::text AS record_type,
    role_row.rolname::text AS object_name,
    concat_ws(',',
      'login=' || role_row.rolcanlogin,
      'superuser=' || role_row.rolsuper,
      'create_role=' || role_row.rolcreaterole,
      'create_db=' || role_row.rolcreatedb,
      'replication=' || role_row.rolreplication,
      'bypass_rls=' || role_row.rolbypassrls
    ) AS detail
  FROM pg_roles role_row
  WHERE role_row.rolname = current_user

  UNION ALL

  SELECT
    'table_security',
    format('%I.%I', namespace_row.nspname, class_row.relname),
    concat_ws(',',
      'rls=' || class_row.relrowsecurity,
      'force_rls=' || class_row.relforcerowsecurity
    )
  FROM pg_class class_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
  WHERE namespace_row.nspname IN ('public', 'squid_processor')
    AND class_row.relkind IN ('r', 'p')

  UNION ALL

  SELECT
    'policy',
    format('%I.%I.%I', policy_row.schemaname, policy_row.tablename, policy_row.policyname),
    concat_ws(',',
      'permissive=' || policy_row.permissive,
      'roles=' || array_to_string(policy_row.roles, ':'),
      'command=' || policy_row.cmd,
      'using=' || coalesce(policy_row.qual, ''),
      'check=' || coalesce(policy_row.with_check, '')
    )
  FROM pg_policies policy_row
  WHERE policy_row.schemaname IN ('public', 'squid_processor')

  UNION ALL

  SELECT
    'table_grant',
    format('%I.%I', grant_row.table_schema, grant_row.table_name),
    concat_ws(',', grant_row.grantee, grant_row.privilege_type, grant_row.is_grantable)
  FROM information_schema.role_table_grants grant_row
  WHERE grant_row.table_schema IN ('public', 'squid_processor')
) AS access_records
ORDER BY record_type, object_name, detail;
SQL
  )"

  psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' <<'SQL' >"${table_list_file}"
SELECT
  namespace_row.nspname,
  class_row.relname,
  quote_ident(namespace_row.nspname),
  quote_ident(class_row.relname)
FROM pg_class class_row
JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
WHERE namespace_row.nspname IN ('public', 'squid_processor')
  AND class_row.relkind IN ('r', 'p')
ORDER BY namespace_row.nspname, class_row.relname;
SQL

  : >"${manifest_file}"
  table_count=0
  exact_rows=0
  migration_table_count=0
  while IFS='|' read -r schema_name table_name quoted_schema quoted_table; do
    [ -n "${schema_name}" ] || continue
    qualified_table="${quoted_schema}.${quoted_table}"
    row_count="$(psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align -c "SELECT count(*) FROM ${qualified_table}")"
    data_sha256="$(
      psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet -c \
        "COPY (SELECT row_json FROM (SELECT row_to_json(cotsel_row)::text AS row_json FROM ${qualified_table} AS cotsel_row) AS serialized_rows ORDER BY row_json) TO STDOUT" \
        | sha256_stream
    )"

    table_count=$((table_count + 1))
    exact_rows=$((exact_rows + row_count))
    case "${table_name}" in
      *migration*) migration_table_count=$((migration_table_count + 1)) ;;
    esac

    record="DATABASE_RECOVERY_TABLE service=${service_name} database=${database_name} schema=${schema_name} table=${table_name} exact_rows=${row_count} data_sha256=${data_sha256}"
    printf '%s\n' "${record}"
    printf '%s\n' "${record}" >>"${manifest_file}"
  done <"${table_list_file}"

  psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' <<'SQL' >"${sequence_list_file}"
SELECT
  namespace_row.nspname,
  class_row.relname,
  quote_ident(namespace_row.nspname),
  quote_ident(class_row.relname)
FROM pg_class class_row
JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
WHERE namespace_row.nspname IN ('public', 'squid_processor')
  AND class_row.relkind = 'S'
ORDER BY namespace_row.nspname, class_row.relname;
SQL

  sequence_count=0
  while IFS='|' read -r schema_name sequence_name quoted_schema quoted_sequence; do
    [ -n "${schema_name}" ] || continue
    qualified_sequence="${quoted_schema}.${quoted_sequence}"
    state_sha256="$(
      psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' \
        -c "SELECT last_value, is_called FROM ${qualified_sequence}" \
        | sha256_stream
    )"
    sequence_count=$((sequence_count + 1))
    record="DATABASE_RECOVERY_SEQUENCE service=${service_name} database=${database_name} schema=${schema_name} sequence=${sequence_name} state_sha256=${state_sha256}"
    printf '%s\n' "${record}"
    printf '%s\n' "${record}" >>"${manifest_file}"
  done <"${sequence_list_file}"

  database_data_sha256="$(LC_ALL=C sort "${manifest_file}" | sha256_stream)"
  printf '%s\n' \
    "DATABASE_RECOVERY_SUMMARY service=${service_name} database=${database_name} server_version=${server_version} tables=${table_count} sequences=${sequence_count} exact_rows=${exact_rows} migration_tables=${migration_table_count} schema_sha256=${schema_sha256} access_sha256=${access_sha256} data_sha256=${database_data_sha256}"
}

collect_database 'auth' 'cotsel_auth' "${AUTH_RUNTIME_USERNAME}" "${AUTH_RUNTIME_PASSWORD}"
collect_database 'gateway' 'cotsel_gateway' "${GATEWAY_RUNTIME_USERNAME}" "${GATEWAY_RUNTIME_PASSWORD}"
collect_database 'indexer' 'cotsel_indexer' "${INDEXER_RUNTIME_USERNAME}" "${INDEXER_RUNTIME_PASSWORD}"
collect_database 'oracle' 'cotsel_oracle' "${ORACLE_RUNTIME_USERNAME}" "${ORACLE_RUNTIME_PASSWORD}"
collect_database 'reconciliation' 'cotsel_reconciliation' "${RECONCILIATION_RUNTIME_USERNAME}" "${RECONCILIATION_RUNTIME_PASSWORD}"
collect_database 'ricardian' 'cotsel_ricardian' "${RICARDIAN_RUNTIME_USERNAME}" "${RICARDIAN_RUNTIME_PASSWORD}"
collect_database 'treasury' 'cotsel_treasury' "${TREASURY_RUNTIME_USERNAME}" "${TREASURY_RUNTIME_PASSWORD}"

unset AUTH_RUNTIME_PASSWORD GATEWAY_RUNTIME_PASSWORD INDEXER_RUNTIME_PASSWORD ORACLE_RUNTIME_PASSWORD
unset RECONCILIATION_RUNTIME_PASSWORD RICARDIAN_RUNTIME_PASSWORD TREASURY_RUNTIME_PASSWORD PGPASSWORD
printf '%s\n' 'Cotsel recovery manifest collection passed.'
