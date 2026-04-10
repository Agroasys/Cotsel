# Postgres Backup Restore Recovery Runbook

## Purpose

- Define deterministic backup and restore procedures for service-critical Postgres datasets.
- Provide operator steps that produce evidence artifacts for pilot and post-pilot recovery drills.

## Critical datasets

These databases are initialized by `postgres/init/10-service-databases.sql` and are in scope for backup and restore operations:

- `INDEXER_DB_NAME` (`agroasys_indexer`)
- `RECONCILIATION_DB_NAME` (`agroasys_reconciliation`)
- `TREASURY_DB_NAME` (`agroasys_treasury`)
- `ORACLE_DB_NAME` (`agroasys_oracle`)
- `RICARDIAN_DB_NAME` (`agroasys_ricardian`)

## Deterministic smoke drill (required evidence)

Run the smoke script from repo root:

```bash
scripts/postgres-backup-restore-smoke.sh
```

Expected artifacts:

- `reports/postgres-recovery/backup-restore-smoke.log`
- `reports/postgres-recovery/backup-restore-smoke.json`

Pass criteria:

- JSON report contains `"pass": true`.
- Log includes `restored sentinel verified successfully`.

## Manual logical backup command (service DB)

Use this when capturing a backup for a specific service database:

```bash
mkdir -p reports/postgres-recovery
docker compose -f docker-compose.services.yml --profile infra exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}" \
  > "reports/postgres-recovery/indexer-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Repeat for each required DB (`RECONCILIATION_DB_NAME`, `TREASURY_DB_NAME`, `ORACLE_DB_NAME`, `RICARDIAN_DB_NAME`).

## Manual restore command (service DB)

Restore into a target database after creating the database and confirming credentials:

```bash
cat reports/postgres-recovery/indexer-<timestamp>.sql \
  | docker compose -f docker-compose.services.yml --profile infra exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}"
```

## Migration safety controls

Migration operations must follow this order:

1. Capture backup for the affected DB before any migration.
2. Run schema migration in controlled scope (single service first).
3. Verify integrity checks (row counts and service health) before proceeding.
4. Roll forward remaining services only after verification passes.

Rollback controls:

1. Stop the affected service profile with `scripts/docker-services.sh down <profile>`.
2. Restore the pre-migration logical backup.
3. Re-run migration only after root cause and ordering fix are documented.

Integrity verification baseline:

- `SELECT COUNT(*)` on service-critical tables before/after restore.
- Service health via `scripts/docker-services.sh health <profile>`.
- Reconciliation/indexer quick checks via `scripts/staging-e2e-real-gate.sh` for staging profiles.

## Capacity, retention, and availability guardrails

- Pilot baseline:
  - Daily logical backups for each service DB.
  - Retain at least 14 days of backups.
  - Weekly restore smoke drill with artifacts attached to ops evidence.
- Post-pilot baseline:
  - Backup cadence based on RPO and data-change rate (minimum daily).
  - Retention aligned to compliance/audit requirements (minimum 30 days unless stricter policy applies).
  - Monthly full restore drill plus ad-hoc drill after major schema migrations.

## Incident triggers for restore

Trigger restore workflow when any of the following occurs:

- Data corruption or accidental destructive write.
- Failed migration that cannot be rolled forward safely.
- Persistent service startup failures tied to DB integrity.
- Audit/reconciliation mismatch that requires known-good DB state recovery.

## CI evidence

- Release gate publishes Postgres smoke evidence under artifact `ci-report-postgres-recovery-smoke`.
- Artifact must contain:
  - `reports/postgres-recovery/backup-restore-smoke.log`
  - `reports/postgres-recovery/backup-restore-smoke.json`
