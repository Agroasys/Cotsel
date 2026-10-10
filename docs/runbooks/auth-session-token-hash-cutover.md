# Auth session token hash cutover

## Purpose

Deploy auth migration `202610100004_session_token_hash_lineage` and the image
that requires it, and recover if that release must be backed out. Use this
runbook with [staging service migrations](staging-service-migrations.md) and
[PostgreSQL backup, restore, and recovery](postgres-backup-restore-recovery.md).

The migration renames `user_sessions.session_id` to `session_token_hash`,
replaces every stored raw token with its SHA-256 verifier, and adds refresh
lineage columns. Hashing is one-way.

## Why this release needs a drained cutover

No compatible staged migration exists for this change:

- Every auth image checks its migration ledger at startup and refuses to start
  when an applied migration is missing from its own manifest
  (`shared-db/migrate.js`). Any new migration therefore stops the previous image
  from starting, whether or not its schema change is additive.
- Keeping a raw-token column for the previous image would keep bearer
  credentials at rest, which this release exists to remove.

Auth runs as a container in the gateway ECS service. That service has the
deployment circuit breaker with `rollback = true`. After `202610100004` is
applied, an automatic or manual rollback to the previous task definition
starts an auth container that fails its startup check, so the gateway task
never becomes healthy. **An image-only rollback is not a recovery path once the
migration has been applied.**

## Image and schema compatibility

| Schema state                    | Previous image                                                                                                                            | Candidate image                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Ledger head `202609130003`      | Starts and serves sessions.                                                                                                               | Refuses to start: `202610100004` is missing.             |
| Ledger head `202610100004`      | Refuses to start: `Applied migration 202610100004 is missing from the manifest`. Already-running tasks fail session queries with `42703`. | Starts. Sessions issued before the migration stay valid. |
| After the reviewed revert below | Starts. Every session is gone; users re-exchange.                                                                                         | Refuses to start until `202610100004` is applied again.  |

## Preconditions

1. Confirm the candidate commit, digest-pinned auth image, and gateway task
   definition revision under review.
2. Record the currently running gateway task definition revision as the
   previous revision.
3. Confirm an encrypted database snapshot or approved point-in-time recovery
   position for the auth database.
4. Confirm the auth ledger head is `202609130003`.
5. Schedule a window. Session exchange, refresh, and authenticated gateway
   requests are unavailable while the service is drained.

## Cutover

1. Drain the gateway service so no previous-image auth container is running:

   ```bash
   aws ecs update-service --region ap-south-1 --cluster <cluster-arn> \
     --service <gateway-service> --desired-count 0
   aws ecs wait services-stable --region ap-south-1 --cluster <cluster-arn> \
     --services <gateway-service>
   ```

2. Run the auth migration task with the candidate task definition, following
   [staging service migrations](staging-service-migrations.md). The migration
   runs in one transaction; if the task fails, the ledger head stays at
   `202609130003`.
3. Confirm the ledger head is `202610100004` and the schema fingerprint matches
   the candidate manifest.
4. Update the gateway service to the candidate task definition and restore its
   desired count.
5. Verify startup, health, a trusted exchange, a refresh, and that a session
   issued before the drain still resolves.

## Recovery

Choose the first path that applies.

### Migration task failed

The ledger head is still `202609130003`, so the previous image is compatible.
Restore the previous revision's desired count, then investigate the failure.

### Migration applied; candidate unhealthy

This includes an ECS circuit-breaker rollback that left the previous revision
failing its startup check.

1. **Roll forward (preferred).** Deploy a fixed candidate that ships the same
   manifest. Sessions are preserved.
2. **Revert to the previous image.** Use this only when no fixed candidate can be
   deployed in time. Every session is invalidated (fail closed); profiles,
   nonces, admin audit, and signer bindings are kept.
   1. Drain the gateway service as in cutover step 1.
   2. Have the database recovery authority approve and record the decision.
   3. Through the approved production database access path, run
      [`auth/recovery/004_session_token_hash_lineage.revert.sql`](../../auth/recovery/004_session_token_hash_lineage.revert.sql)
      as the auth migration role, from the reviewed commit. It refuses to run
      unless the ledger head is `202610100004`, and it applies atomically.
   4. Confirm the ledger head is `202609130003` and the schema fingerprint
      matches that migration's pinned `schema_sha256`.
   5. Deploy the previous revision and restore its desired count.
   6. Verify startup, health, and a trusted exchange.

   To retry the release later, start again from **Cutover**.

3. **Restore.** Restore the snapshot only when neither path preserves the
   required data, following
   [PostgreSQL backup, restore, and recovery](postgres-backup-restore-recovery.md).

`auth/tests/sessionCutoverRecovery.integration.test.ts` proves this matrix
against PostgreSQL 16:

- the previous image fails after the migration;
- the revert restores its startup check, grants, and session SQL;
- `202610100004` can be applied again afterwards.

## Evidence record

Record the previous and candidate task definition revisions, the image digests,
the database recovery position, the migration task ARN, ledger heads and schema
fingerprints before and after, drain and restore timestamps (UTC), the
verification results, and any recovery decision with its authority. Never
record session tokens, token hashes, or database credentials.
