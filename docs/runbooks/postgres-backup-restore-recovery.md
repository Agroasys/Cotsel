# AWS Postgres Backup And Recovery

## Purpose

Use this procedure to audit backup controls, restore the AWS staging database
to an isolated RDS instance, and prove that the restored financial state is
complete. This procedure produces WP-5 evidence. It does not authorize a pilot,
delete a database, enable AWS Backup Vault Lock, or resume settlement.

## Current scope

The staging PostgreSQL instance contains seven Cotsel service databases:

- `cotsel_auth`
- `cotsel_gateway`
- `cotsel_indexer`
- `cotsel_oracle`
- `cotsel_reconciliation`
- `cotsel_ricardian`
- `cotsel_treasury`

The backend database is a separate recovery surface and remains governed by the
backend work packages. Redis, queues, S3 objects, chain state, and provider
records are not PostgreSQL backups. Their recovery and reconciliation remain
separate requirements.

## Controls and known blockers

Run the read-only control audit from the repository root:

```bash
scripts/audit-aws-postgres-recovery.sh
```

The JSON output identifies the exact account, region, RDS instance, native PITR
window, AWS Backup plan, retention, recovery-point count, and Vault Lock state.
The script exits nonzero when a required control is absent.

The audit binds each completed recovery point to the active plan and required
source vault. The latest point must be no more than 48 hours old. It does not
accept a copy action as off-site recovery proof.

Set `COTSEL_RECOVERY_OBJECTIVES_REFERENCE` to the immutable approval record for
the recovery objectives. The default thresholds are technical configuration
checks. They are not an approved recovery point objective or recovery time
objective. The audit cannot return `VERIFIED` without the approval reference.

If an approved recovery account exists, set these non-secret identifiers:

- `COTSEL_OFFSITE_AWS_PROFILE`
- `COTSEL_OFFSITE_AWS_ACCOUNT_ID`
- `COTSEL_OFFSITE_AWS_REGION`
- `COTSEL_OFFSITE_BACKUP_VAULT_NAME`

The profile must use read-only access to the recovery account. The audit passes
off-site custody only when it proves the matching copy action, retention, locked
destination vault, and completed encrypted recovery point.

As of 27 August 2026, the current live staging evidence proves encrypted,
private, deletion-protected, Multi-AZ RDS PostgreSQL; seven days of native PITR;
and a 35-day AWS Backup plan with completed recovery points. It also proves that
the backup vault is in the same account and AWS Backup Vault Lock is disabled.
Vault Lock remains `MISCONFIGURED`. No cross-account or otherwise approved
off-site copy is proven, so off-site custody remains `BLOCKED`. Both require an
approved retention and governance design before implementation.

Do not enable compliance-mode Vault Lock as an audit shortcut. Its retention
controls can become irreversible. Record the approved retention, grace period,
authority, and recovery-account design first.

Approved RPO and RTO values are blocked on
`Agroasys/agroasys-backend#516`. A restore drill measures actual recovery point
and recovery time; it cannot invent or approve their business objectives.

## Required roles

Use separate people for these actions:

1. The implementer prepares the exact source, Terraform plan, and drill packet.
2. The plan reviewer approves the exact plan and restore parameters.
3. The recovery operator starts the restore and verifier tasks.
4. Data, Finance, and Operations review the restored evidence and reconciliation.

The implementer cannot accept their own restore. Record every actor, timestamp,
reviewed commit, Terraform state version, task definition, task ARN, and RDS
identifier.

## Stop conditions

Stop the drill and keep all financial workflows disabled if any condition is
true:

- The AWS account is not `655177116834` or the region is not `ap-south-1`.
- The source instance is not `agroasys-staging`.
- The selected restore time is outside the live PITR window.
- A Terraform plan contains a destroy, source database replacement, secret
  mutation, network replacement, Treasury start, contract change, or RPC change.
- Source writers are not frozen for the source-manifest interval.
- A credential was rotated between the selected restore time and verifier run.
- The restored instance is public or uses unapproved subnets or security groups.
- A source and target manifest differs.
- Entitlement, forced-RLS, migration, service-readiness, re-index, or financial
  reconciliation evidence fails.
- Logs contain credentials, connection strings, row values, or personal data.

## Before the drill

1. Approve the drill change window and the maximum temporary RDS cost.
2. Confirm no deployment, migration, credential rotation, DNS change, or
   settlement rehearsal overlaps the drill.
3. Record the exact source commit, task definitions, image digests, Terraform
   state version, RDS ARN, latest restorable time, and latest completed AWS
   Backup recovery point.
4. Confirm the RDS parameter group, option group, subnet group, security groups,
   KMS key, port, instance class, storage configuration, and engine version from
   live AWS state. Do not reconstruct these values from memory.
5. Freeze all seven Cotsel database writers through the reviewed service-control
   procedure. Treasury must remain at desired count zero.
6. Record the writer-freeze timestamp and prove no active writer remains.
7. Run the source recovery-manifest task described below.
8. Choose a PITR timestamp after the writer freeze and source manifest. Record
   that timestamp exactly.

The source freeze is necessary because table fingerprints are collected in
separate read-only statements. Without a freeze, concurrent writes can create a
manifest that never represented one consistent database state.

## Collect the source manifest

Resolve the exact task family, cluster, private subnets, and security groups from
the reviewed Terraform outputs. Run the registered
`database-parity-verification` task with no command override and no environment
override for the source.

The task:

- receives only the seven runtime credentials;
- has no application task role;
- connects with TLS certificate verification;
- emits exact per-table row counts and deterministic data fingerprints;
- emits sequence-state fingerprints;
- emits database-level schema, access, and data fingerprints;
- never emits row contents, passwords, or endpoints.

Wait for exit code zero. Export the exact CloudWatch log stream to a protected,
redacted evidence file. Preserve the log group, stream, task ARN, task-definition
revision, start and stop times, and source RDS identifier.

## Restore to an isolated RDS instance

Generate the restore command from current `describe-db-instances` output and the
reviewed drill packet. Do not paste a generic command from this runbook and fill
values from memory.

The reviewed restore request must use:

- a new unique identifier that includes the UTC drill timestamp;
- the approved point in time;
- the current engine and compatible instance class;
- the current DB subnet group;
- only the approved database security groups;
- the current KMS key and storage settings;
- `PubliclyAccessible=false`;
- `MultiAZ=true` unless the approved drill explicitly documents why the
  temporary target is different;
- deletion protection while evidence and review remain open;
- no DNS or application cutover.

Use `aws rds restore-db-instance-to-point-in-time` only after counterpart approval
of those exact parameters. Record the CloudTrail event and wait until the target
is available. Prove the target is encrypted, private, and isolated before any
verifier connects.

Do not mutate the restored database to make a failed comparison pass. A required
credential rotation after the chosen restore point invalidates the drill and
requires a newly approved recovery method or restore point.

## Collect and compare the target manifest

Run the same immutable `database-parity-verification` task definition. The only
permitted override is this non-secret environment value:

```text
COTSEL_POSTGRES_HOST=<restored-rds-endpoint-hostname>
```

Do not override the command, image, credentials, task role, execution role,
network, or logging configuration. Keep the target endpoint out of public issue
comments even though it is not a credential.

Export the target log stream, then compare the two protected files:

```bash
scripts/compare-postgres-recovery-manifests.mjs \
  <source-manifest-log> \
  <restored-target-manifest-log>
```

Pass requires `classification: VERIFIED` and zero differences across all seven
database summaries and every table record. A missing table, unexpected table,
row-count mismatch, schema mismatch, access mismatch, or data-fingerprint
mismatch fails the restore.

The comparator also recalculates summary counts and data fingerprints. It
rejects malformed hashes, missing migration ledgers, and internally inconsistent
manifests before it compares source and target.

## Prove roles, RLS, and runtime denial

Run the same immutable `database-entitlement-verification` task against the
restored endpoint using only the permitted `COTSEL_POSTGRES_HOST` override.
Do not use a command override.

Pass requires:

- the Indexer, Ricardian, and Treasury migration roles can perform transactional
  DDL only in their databases;
- their runtime roles can connect only to their databases;
- their runtime and GraphQL roles cannot perform DDL;
- the indexer migrator owns the required schemas and objects;
- the indexer reader cannot write or access processor state;
- cross-database access fails for the identities in the verifier.

The source and target access fingerprints must also match for all seven
databases. Run the exact candidate's database integration suite to prove forced
RLS and service-session behavior. The remaining all-service live entitlement
coverage is still required before WP-5 acceptance; do not infer it from the
three-service verifier.

The entitlement verifier and manifest comparator prove different properties.
Both must pass.

## Migration recovery

Use the versioned migration job. Do not run a migration from an application
task or an ad hoc command override.

Before a migration, complete these actions:

1. Capture the source manifest.
2. Record the compatible application rollback revision.
3. Verify the migration-manifest checksum at the reviewed commit.
4. Run one dedicated migration task.
5. Verify the migration ledger and schema fingerprint.
6. Compare critical counts and financial aggregates.
7. Verify the prior application revision, when it remains compatible.
8. Verify the candidate application revision.

If the migration fails, stop the affected rollout. Prefer a compatible
application rollback or a reviewed roll-forward. Restore only when neither
path safely preserves data. Reconcile financial and chain state before service
recovery resumes. Record the decision, authority, and restored invariant.

## Service, indexer, and financial recovery

Do not point the normal staging services at the restored target. Use the approved
private recovery environment and exact candidate images.

Verify in this order:

1. Migration identities match the source candidate.
2. Auth sessions and trusted-session replay state are present and bounded.
3. Gateway idempotency, callback, audit, and durable settlement records match.
4. Oracle trigger and nonce state matches.
5. Ricardian hashes and evidence references match.
6. Indexer checkpoints and canonical event identities match.
7. Re-index from the accepted contract start block to the recorded comparison
   block and prove the resulting canonical fingerprints.
8. Reconciliation compares restored operational state, indexed chain facts,
   Treasury state, and backend ledger state at the same block boundary.
9. A safe negative fixture still creates durable mismatch evidence.
10. Service readiness passes without enabling public traffic or Treasury.

Redis, queues, chain data, and third-party provider state must be reconciled from
their authoritative sources. Do not present a PostgreSQL restore as proof that
those systems recovered.

## Measure recovery

Record these timestamps in UTC:

- last source write included by the restore;
- selected PITR timestamp;
- restore request accepted;
- target became available;
- manifest comparison passed;
- entitlement verification passed;
- re-index completed;
- reconciliation passed;
- recovery acceptance decision.

Calculate the achieved data-loss interval and recovery duration from the
recorded facts. Compare them with the approved objectives from backend issue
`#516`. Until that approval exists, classify the measured results as evidence
without claiming that RPO or RTO passed.

## Cleanup

Cleanup is a separate destructive change.

1. Obtain approval for the exact restored RDS identifier.
2. Preserve the evidence bundle and any required final snapshot.
3. Confirm no task, DNS record, secret, or operator procedure references the
   target.
4. Disable deletion protection through the reviewed mechanism.
5. Delete only the temporary restored target. Never target
   `agroasys-staging`.
6. Verify the CloudTrail deletion event and retained recovery evidence.

## Evidence and acceptance

The evidence packet must include:

- audit JSON from `scripts/audit-aws-postgres-recovery.sh`;
- source and target RDS identifiers and configuration summaries;
- selected PITR timestamp and recovery-point identifiers;
- source and target verifier task definitions, task ARNs, exit codes, and
  CloudWatch log references;
- redacted manifests and comparison report;
- entitlement, RLS, migration, readiness, re-index, and reconciliation results;
- achieved recovery measurements and approved RPO/RTO comparison;
- source commit, image digests, Terraform state version, chain ID, accepted
  contract, deployment block, and comparison block;
- implementer, reviewer, operator, Data, Finance, and Operations decisions.

Classify the issue `PARTIALLY VERIFIED` until a clean restore, re-index,
reconciliation, objective comparison, and named acceptance all pass for one
pinned candidate.

## Local smoke test

`scripts/postgres-backup-restore-smoke.sh` remains a CI test of basic logical
dump and restore mechanics for one synthetic sentinel. It is not AWS PITR,
seven-database restore, production-size, role, RLS, or financial recovery
evidence and cannot close WP-5.
