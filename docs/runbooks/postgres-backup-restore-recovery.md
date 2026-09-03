# Postgres Backup Restore Recovery Runbook

## Purpose

- Define deterministic backup and restore procedures for service-critical Postgres datasets.
- Provide operator steps that produce evidence artifacts for pilot and post-pilot recovery drills.

## Critical datasets

These seven service databases are in scope:

- auth
- gateway
- indexer
- oracle
- reconciliation
- ricardian
- treasury

Use the database identifiers from the target environment. Do not assume local
compose names match AWS names.

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
docker compose -f docker-compose.services.yml --profile runtime exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}" \
  > "reports/postgres-recovery/indexer-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Repeat for each required DB (`RECONCILIATION_DB_NAME`, `TREASURY_DB_NAME`, `ORACLE_DB_NAME`, `RICARDIAN_DB_NAME`).

## Manual restore command (service DB)

Restore into a target database after creating the database and confirming credentials:

```bash
cat reports/postgres-recovery/indexer-<timestamp>.sql \
  | docker compose -f docker-compose.services.yml --profile runtime exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}"
```

## Migration safety controls

Migration operations must follow this order:

1. Capture backup for the affected DB before any migration.
2. Record the application rollback revision and compatibility window.
3. Verify the manifest checksum against the reviewed commit.
4. Run the dedicated migration task for one service.
5. Verify its migration ledger and schema identity.
6. Compare critical counts and financial aggregates.
7. Verify service health with the prior application revision.
8. Verify service health with the candidate revision.
9. Continue only after both compatibility checks pass.

Rollback controls:

1. Stop the affected rollout.
2. Prefer a compatible application rollback or reviewed roll-forward.
3. Restore only when neither path safely preserves data.
4. Reconcile financial and chain state before resuming.
5. Document the decision, authority, and restored invariant.

Integrity verification baseline:

- `SELECT COUNT(*)` on service-critical tables before/after restore.
- Service health via `scripts/cotsel.sh health`.
- Reconciliation/indexer quick checks via `scripts/runtime-gate.sh` for staging profiles.

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
