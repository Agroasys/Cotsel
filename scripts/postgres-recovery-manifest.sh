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

umask 077
work_directory="$(mktemp -d "${TMPDIR:-/tmp}/cotsel-recovery.XXXXXXXXXX")"
export PGSSLROOTCERT="${work_directory}/aws-rds-global-bundle.pem"
stream_complete_file="${work_directory}/stream-complete"
cleanup() {
  rm -rf "${work_directory}"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

wget --quiet -O "${PGSSLROOTCERT}" 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'
sha256sum -c -s <<EOF
90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  ${PGSSLROOTCERT}
EOF

run_verifier_check() {
  check_name="${1}"
  shift
  # Client diagnostics can contain credentials, connection details, or row values.
  if ! "$@" 2>/dev/null; then
    printf 'Database recovery verification failed for service %s during %s.\n' "${service_name}" "${check_name}" >&2
    return 1
  fi
}

sha256_stream() {
  # POSIX sh returns the final command's status for a pipeline. Record producer
  # success separately while piping its output directly into sha256sum.
  rm -f "${stream_complete_file}" || return 1
  checksum="$(
    (run_verifier_check "$@" && : >"${stream_complete_file}") \
      | run_verifier_check 'SHA-256 calculation' sha256sum
  )" || return 1
  [ -f "${stream_complete_file}" ] || return 1
  printf '%s\n' "${checksum%% *}"
}

collect_preflight_metadata() {
  # The ledger and reconciliation cutover checks share one snapshot per database.
  # Recovery fingerprints are collected separately and still require a write freeze.
  preflight_metadata="$(
    run_verifier_check 'migration preflight query' psql --no-psqlrc --dbname "${database_name}" \
      --set ON_ERROR_STOP=1 --set "service=${service_name}" --set "database=${database_name}" \
      --quiet --tuples-only --no-align <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT
  :'service' = 'indexer' AS is_indexer,
  :'service' = 'reconciliation' AS is_reconciliation,
  to_regclass(CASE WHEN :'service' = 'indexer'
    THEN 'public.migrations' ELSE 'public.cotsel_schema_migrations' END) IS NOT NULL AS ledger_present
\gset

\if :ledger_present
WITH ledger AS (
\if :is_indexer
  -- Older TypeORM ledgers may have no checksum column or contain NULL checksums.
  SELECT id AS ordering, timestamp::text AS version,
    trim(to_jsonb(migration)->>'checksum') AS checksum,
    NULL::text AS schema_checksum, 'unknown' AS application_mode
  FROM public.migrations migration
\else
  SELECT row_number() OVER (ORDER BY version) AS ordering, version,
    trim(checksum) AS checksum, trim(schema_checksum) AS schema_checksum, application_mode
  FROM public.cotsel_schema_migrations
  WHERE service_name = :'service'
\endif
), ledger_summary AS (
  SELECT count(*) AS entries, count(*) FILTER (WHERE checksum IS NULL) AS missing_checksums,
    count(*) = count(DISTINCT version) AND count(*) FILTER (WHERE (
      version ~ '^[0-9]{12,14}$'
      AND (checksum ~ '^[a-f0-9]{64}$' OR (:'is_indexer'::boolean AND checksum IS NULL))
      AND (schema_checksum ~ '^[a-f0-9]{64}$' OR (:'is_indexer'::boolean AND schema_checksum IS NULL))
      AND (application_mode IN ('adopted', 'executed') OR (:'is_indexer'::boolean AND application_mode = 'unknown'))
    ) IS NOT TRUE) = 0 AS valid
  FROM ledger
)
SELECT record FROM (
  SELECT 0 AS record_group, 0 AS ordering,
    CASE WHEN valid THEN format(
      'COTSEL_DB_PREFLIGHT_LEDGER service=%s database=%s present=true entries=%s missing_checksums=%s',
      :'service', :'database', entries, missing_checksums
    ) ELSE 'COTSEL_DB_PREFLIGHT_INVALID' END AS record
  FROM ledger_summary
  UNION ALL
  SELECT 1, ordering, format(
    'COTSEL_DB_PREFLIGHT_MIGRATION service=%s database=%s version=%s sha256=%s schema_sha256=%s application_mode=%s',
    :'service', :'database', version, coalesce(checksum, 'missing'),
    coalesce(schema_checksum, 'none'), application_mode
  )
  FROM ledger
) AS records
ORDER BY record_group, ordering;
\else
SELECT format('COTSEL_DB_PREFLIGHT_LEDGER service=%s database=%s present=false entries=0 missing_checksums=0',
  :'service', :'database');
\endif

\if :is_reconciliation
SELECT CASE WHEN public.current_app_service_name() = 'reconciliation'
    AND row_security_active('public.reconcile_trade_containments') THEN format(
    'COTSEL_DB_PREFLIGHT_LEGACY_CONTAINMENT service=%s database=%s signed_runs_present=%s contained=%s reconciled_pending_approval=%s',
    :'service', :'database', (to_regclass('public.reconcile_run_manifests') IS NOT NULL)::text,
    count(*) FILTER (WHERE state = 'CONTAINED'), count(*) FILTER (WHERE state = 'RECONCILED_PENDING_APPROVAL')
  ) ELSE 'COTSEL_DB_PREFLIGHT_INVALID' END
FROM public.reconcile_trade_containments;
\endif

COMMIT;
SQL
  )" || return 1
  case "${preflight_metadata}" in
    ''|*COTSEL_DB_PREFLIGHT_INVALID*)
      printf 'Database recovery verification failed for service %s during migration preflight validation.\n' "${service_name}" >&2
      return 1
      ;;
  esac
  printf '%s\n' "${preflight_metadata}"
}

collect_database() {
  service_name="${1}"
  database_name="${2}"
  runtime_username="${3}"
  runtime_password="${4}"
  manifest_file="${work_directory}/${service_name}.manifest"
  table_list_file="${work_directory}/${service_name}.tables"
  sequence_list_file="${work_directory}/${service_name}.sequences"

  export PGUSER="${runtime_username}"
  export PGPASSWORD="${runtime_password}"
  export PGOPTIONS="-c default_transaction_read_only=on -c app.service_name=${service_name} -c app.connection_role=runtime -c app.runtime_db_user=${runtime_username}"

  collect_preflight_metadata
  server_version="$(run_verifier_check 'server version query' psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align -c "SELECT current_setting('server_version_num')")"

  schema_sha256="$(
    sha256_stream 'schema fingerprint' pg_dump \
      --dbname "${database_name}" \
      --schema=public --schema=squid_processor \
      --schema-only \
      --no-owner \
      --no-privileges \
      --no-comments \
      --restrict-key='cotselrecovery'
  )"

  access_sha256="$(
    sha256_stream 'access fingerprint' psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' <<'SQL'
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

  run_verifier_check 'table catalog query' psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' <<'SQL' >"${table_list_file}"
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
    row_count="$(run_verifier_check 'row count query' psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align -c "SELECT count(*) FROM ${qualified_table}")"
    data_sha256="$(
      sha256_stream 'table data fingerprint' psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet -c \
        "COPY (SELECT row_json FROM (SELECT row_to_json(cotsel_row)::text AS row_json FROM ${qualified_table} AS cotsel_row) AS serialized_rows ORDER BY row_json) TO STDOUT"
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

  run_verifier_check 'sequence catalog query' psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' <<'SQL' >"${sequence_list_file}"
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
      sha256_stream 'sequence state fingerprint' psql --dbname "${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' \
        -c "SELECT last_value, is_called FROM ${qualified_sequence}"
    )"
    sequence_count=$((sequence_count + 1))
    record="DATABASE_RECOVERY_SEQUENCE service=${service_name} database=${database_name} schema=${schema_name} sequence=${sequence_name} state_sha256=${state_sha256}"
    printf '%s\n' "${record}"
    printf '%s\n' "${record}" >>"${manifest_file}"
  done <"${sequence_list_file}"

  database_data_sha256="$(LC_ALL=C sha256_stream 'manifest sort' sort "${manifest_file}")"
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
