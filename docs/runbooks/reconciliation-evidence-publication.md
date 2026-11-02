# Reconciliation evidence publication

Audience: reconciliation and Treasury operators. Scope: migration `006_completed_evidence.sql` and historical export reads.
Prerequisites: reviewed migration, database backup, and the approved evidence retention policy.
Outcome: completed reconciliation evidence remains stable for a recorded export run.

## Publication contract

A transition from `RUNNING` to `COMPLETED` assigns `export_evidence_version=1`.
The run, its trade scope, and its drift findings then become immutable.
Child writes lock their parent before checking publication state. Completion waits for those writes.
Normal finalization can clear the lease owner and expiry after publication. It cannot change evidence fields.

Existing completed runs retain a null version. The migration does not certify old evidence.
Publish a fresh reconciliation run before constructing Treasury snapshots that require version 1.
A dedicated Treasury reader needs SELECT permission and the existing reconciliation service context.
The protocol function does not grant write permission. Missing or disabled guards make the protocol check fail.

An export records one published run identity. Later reconciliation runs have different identities.
Historical reporting does not authorize payouts. Financial actions continue to assess current eligibility.

## Verification

1. Run the versioned migration with the approved migration identity.
2. Verify the manifest checksum and resulting schema fingerprint.
3. Query `SELECT public.reconciliation_export_evidence_version()` with the dedicated reader.
4. Confirm the result is `1`.
5. Complete a fresh run through the reconciliation service.
6. Verify its version, coverage, trade scope, and drift counts.
7. Run the PostgreSQL publication and Treasury snapshot tests.

## Retention and rollback

TRUNCATE is prohibited on the three evidence tables. Published rows cannot be deleted through normal DML.
Do not disable guards to repair a financial finding. Publish a fresh run with corrected source evidence.
Accepted evidence requires the approved custody and destruction process before any separate archival maintenance.
This migration does not implement automatic evidence deletion.

Roll back the application before changing this additive schema. Keep the migration and retained data installed.
Older reconciliation code still publishes through `RUNNING` to `COMPLETED` and clears the lease normally.
A schema rollback requires a separately reviewed operator plan and preservation of all accepted evidence.
Do not remove the version column or guards while a Treasury snapshot builder uses this protocol.

Local tests establish database behavior. Staging compatibility, custody, recovery, and independent acceptance remain separate gates.
