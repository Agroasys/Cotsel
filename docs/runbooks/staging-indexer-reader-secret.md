# Staging Indexer Reader Secret

## Purpose

Create and populate the dedicated AWS Secrets Manager credential for the
staging indexer GraphQL reader. This procedure creates no database role and
does not deploy a service.

The reader credential must remain separate from the indexer pipeline runtime
credential. The GraphQL task uses this secret after the indexer-role rollout.

## Preconditions

1. Confirm AWS account `655177116834` and region `ap-south-1`.
2. If the secret identity is absent, review a plan that creates only that identity.
3. If the secret identity is absent, confirm that the plan does not start services or update task definitions.
4. If the secret identity is absent, obtain the required counterpart approval for the reviewed plan.
5. Confirm that the secret has no versions before you create its first value.
6. If a task definition references the secret, stop all Cotsel staging services.
7. Confirm that each service has zero desired, running, and pending tasks.
8. Confirm that the Cotsel staging cluster has no running or starting tasks.
9. Confirm that no autoscaling target can start a Cotsel staging service.
10. Keep the services stopped until the database role verifier passes.
11. Do not enable shell tracing.

## Create the secret identity

1. If the secret identity is absent, apply the exact approved plan through the protected workflow.
2. Record the plan workflow and apply workflow identifiers.
3. Record the secret ARN without reading a secret value.

The secret name is:

`/agroasys/staging/cotsel/database/indexer/reader`

## Populate the secret

1. Open AWS Secrets Manager in `ap-south-1`.
2. Select the reader secret.
3. Create an `AWSCURRENT` secret version with these JSON keys:
   - `username`: `cotsel_indexer_reader`
   - `password`: a newly generated high-entropy password
4. Do not add the reader credential to `database/indexer/runtime`.
5. Do not enter the value into Terraform, GitHub variables, task definitions,
   logs, issue comments, or this runbook.
6. Record only the secret ARN and version identifier in the evidence ledger.

## Verify metadata

1. Confirm that the secret has an `AWSCURRENT` version.
2. Confirm the value is not shown in terminal output or recorded as evidence.
3. If a task definition references the secret, confirm that all Cotsel services remain stopped.
4. Stop if a Cotsel task starts before the database role verifier passes.

The indexer-role rollout creates the database role and grants. Run the role
verifier before you start the GraphQL reader.

## Failure handling

1. Do not delete the secret when the value is missing or incorrect.
2. Create a new version after the error is understood and approved.
3. Record the invalidated version identifier without recording the value.
4. Do not start the GraphQL reader until the later role verifier passes.
