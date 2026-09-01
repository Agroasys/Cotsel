# Staging indexer migration

## Purpose

Run the Cotsel staging indexer schema migration with its dedicated ECS task.
The task uses a digest-pinned image and a migration-only database credential.

This procedure does not deploy the long-running runtime or accept a release.

## Preconditions

1. Confirm AWS account `655177116834` and region `ap-south-1`.
2. Confirm the reader-secret prerequisite was applied from its reviewed Terraform plan.
3. Confirm the dedicated reader secret has an `AWSCURRENT` version with only
   `username` and `password` keys. Do not read or record the values.
4. Confirm the database backup and forward-fix plan are approved.
5. Confirm each applied TypeORM migration has a recorded SHA-256 checksum.
6. Stop if an applied migration has no checksum.
7. Stop if another indexer migration task is running.
8. Do not pass credentials through command arguments or task overrides.
9. Generate and approve the saved `staging-platform` Terraform plan. Do not
   apply it before the reader-secret prerequisite is complete.
10. Confirm the plan creates `cotsel-staging-indexer-migrate` and does not start
    Treasury.
11. Apply the exact approved saved Terraform plan through the protected workflow.
12. Run the exact database bootstrap task without command overrides.
13. Confirm the bootstrap task exited with code `0`.

## Resolve non-secret runtime coordinates

Run these commands from `infra/terraform/staging-platform`:

```bash
terraform output -json indexer_migration_runtime
terraform output -json runtime_dependencies
terraform output -raw cluster_arn
```

Record these values from the outputs:

- the current migration task family and revision;
- the private subnet IDs;
- the internal-services security group ID;
- the data-client security group ID;
- the ECS cluster ARN.

Do not record database credentials or secret values.

## Run the migration

Use the recorded values in this command:

```bash
aws ecs run-task \
  --region ap-south-1 \
  --cluster <cluster-arn> \
  --task-definition <task-family>:<task-revision> \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<private-subnet-1>,<private-subnet-2>],securityGroups=[<internal-services-security-group>,<data-client-security-group>],assignPublicIp=DISABLED}'
```

Record the returned task ARN. Do not reuse an older task-definition revision.

## Verify the result

1. Wait for the task to stop:

   ```bash
   aws ecs wait tasks-stopped \
     --region ap-south-1 \
     --cluster <cluster-arn> \
     --tasks <task-arn>
   ```

2. Read the stopped reason and container exit code:

   ```bash
   aws ecs describe-tasks \
     --region ap-south-1 \
     --cluster <cluster-arn> \
     --tasks <task-arn> \
     --query 'tasks[0].{stoppedReason:stoppedReason,containers:containers[].{name:name,exitCode:exitCode,reason:reason}}'
   ```

3. Confirm `indexer-migrate` exited with code `0`.
4. Inspect the `migrate` stream in `/agroasys/cotsel/staging/indexer-pipeline`.
5. Confirm logs contain no credential or connection-string values.
6. Confirm the applied row count equals the reviewed manifest count.
7. Confirm each applied row contains a 64-character checksum.
8. Confirm each checksum matches `indexer/db/migrations.json`.
9. Run the same migration task again.
10. Confirm the second task reports no pending migration.
11. Confirm the indexer runtime starts and reports the expected migration head.
12. Run the exact `database-entitlement-verification` task without overrides.
13. Confirm the verifier reports all indexer ownership and denial checks as passed.
14. Confirm `indexer-pipeline` uses `cotsel_indexer_app`.
15. Confirm `indexer-graphql` uses `cotsel_indexer_reader`.
16. Confirm neither container receives the migration secret.
17. Confirm GraphQL has no public load-balancer route or public IP.
18. Restart the indexer and confirm processor state resumes without DDL errors.

After a restore, repeat Steps 12 through 18. A successful restore does not prove
that ownership, default privileges, or cross-database isolation were retained.

## Failure handling

1. Do not rerun automatically after an unknown failure.
2. Preserve the task ARN, stopped reason, exit code, and redacted log stream.
3. Confirm whether the migration is transactional and safe to retry.
4. Do not infer checksums for existing unchecksummed history.
5. Create a reviewed adoption design for unchecksummed history.
6. Use the approved forward-fix or restore procedure.
7. Reconcile database state before restarting the indexer runtime.
8. Stop if the runtime attempts schema DDL or any object is not migration-owned.

## Evidence

Record the source commit, image digest, task-definition revision, task ARN,
UTC timestamps, exit code, migration head, operator, and independent reviewer.
Never record secret values or authenticated connection strings.
