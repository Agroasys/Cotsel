# Staging service database migrations

## Purpose

Run a Cotsel service schema migration through its dedicated, private ECS task.
This procedure covers `auth`, `gateway`, `oracle`, `reconciliation`,
`ricardian`, and `treasury`. The indexer uses the separate staging indexer
migration runbook.

Long-running tasks cannot retrieve migration credentials and do not run schema
DDL. A successful migration does not deploy or accept a release.

## Preconditions

1. Confirm AWS account `655177116834` and region `ap-south-1`.
2. Confirm the source commit and digest-pinned image under review.
3. Apply only the independently reviewed `staging-platform` Terraform plan.
4. Confirm an encrypted database snapshot or approved point-in-time recovery
   position exists before schema-changing work.
5. Review the exact schema change, forward-fix procedure, expected lock scope,
   and compatibility with the currently running image.
6. Confirm a baseline migration targets an empty `public` schema.
7. Stop the rollout if a baseline targets a populated schema.
8. Confirm no migration task for the same service is running.
9. Do not supply credentials, environment variables, or commands as task
   overrides.

## Resolve non-secret coordinates

From `infra/terraform/staging-platform`, record:

```bash
terraform output -json service_migration_runtimes
terraform output -json runtime_dependencies
terraform output -raw cluster_arn
```

Select the current task family and revision for exactly one service. Record the
private subnet IDs, internal-services security group, data-client security
group, and ECS cluster ARN. Do not read or record a secret value.

## Run one migration

```bash
aws ecs run-task \
  --region ap-south-1 \
  --cluster <cluster-arn> \
  --task-definition <service-task-family>:<task-revision> \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<private-subnet-1>,<private-subnet-2>],securityGroups=[<internal-services-security-group>,<data-client-security-group>],assignPublicIp=DISABLED}'
```

The request must contain no `overrides` object. Record the returned task ARN.

## Verify before deployment

1. Wait for the task to stop:

   ```bash
   aws ecs wait tasks-stopped \
     --region ap-south-1 \
     --cluster <cluster-arn> \
     --tasks <task-arn>
   ```

2. Verify the stopped reason and exit code:

   ```bash
   aws ecs describe-tasks \
     --region ap-south-1 \
     --cluster <cluster-arn> \
     --tasks <task-arn> \
     --query 'tasks[0].{taskDefinition:taskDefinitionArn,stoppedReason:stoppedReason,containers:containers[].{name:name,exitCode:exitCode,reason:reason}}'
   ```

3. Confirm the single migration container exited `0`.
4. Inspect the `migrate` log stream in the service CloudWatch log group and
   confirm the success marker names the expected service.
5. Confirm CloudTrail `RunTask` evidence has no command or environment
   overrides.
6. Run the service-specific schema/entitlement check, then deploy the matching
   long-running image revision.
7. Confirm the runtime task definition has no migration secret ARN.
8. Confirm the runtime application image contains no startup migration path.
9. Confirm the runtime role can read only its migration ledger rows.
10. Prove startup fails when the expected ledger row is missing or changed.
11. Prove startup, health, and a representative authenticated read.

## Failure handling

Do not blindly retry. Preserve the task ARN, revision, exit code, redacted log
stream, and database recovery position. Baseline failures on populated schemas
require a new reviewed adoption design. Use a reviewed forward fix or restore.

## Evidence record

Record the service, source commit, image digest, task definition revision, task
ARN, database recovery position, UTC timestamps, exit code, redacted log stream,
post-migration schema identity, operator, and independent reviewer. Never record
database credentials, connection strings, or secret values.
