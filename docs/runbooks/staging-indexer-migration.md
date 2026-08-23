# Staging indexer migration

## Purpose

Run the Cotsel staging indexer schema migration with its dedicated ECS task.
The task uses a digest-pinned image and a migration-only database credential.

This procedure does not deploy the long-running runtime or accept a release.

## Preconditions

1. Confirm AWS account `655177116834` and region `ap-south-1`.
2. Apply the reviewed `staging-platform` Terraform plan through the protected workflow.
3. Confirm the plan created `cotsel-staging-indexer-migrate`.
4. Confirm the database backup and forward-fix plan are approved.
5. Stop if another indexer migration task is running.
6. Do not pass credentials through command arguments or task overrides.

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
6. Confirm the indexer runtime starts and reports the expected migration head.

## Failure handling

1. Do not rerun automatically after an unknown failure.
2. Preserve the task ARN, stopped reason, exit code, and redacted log stream.
3. Confirm whether the migration is transactional and safe to retry.
4. Use the approved forward-fix or restore procedure.
5. Reconcile database state before restarting the indexer runtime.

## Evidence

Record the source commit, image digest, task-definition revision, task ARN,
UTC timestamps, exit code, migration head, operator, and independent reviewer.
Never record secret values or authenticated connection strings.
