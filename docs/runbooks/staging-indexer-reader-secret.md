# Staging Indexer Reader Secret

## Purpose

Create and populate the dedicated AWS Secrets Manager credential for the
staging indexer GraphQL reader. This procedure creates no database role and
does not deploy a service.

The reader credential must remain separate from the indexer pipeline runtime
credential. The GraphQL task uses this secret after the indexer-role rollout.

## Preconditions

1. Confirm AWS account `655177116834` and region `ap-south-1`.
2. Confirm the reviewed Terraform plan creates only the reader secret identity.
3. Confirm the plan does not update an ECS task definition or start a service.
4. Obtain the required counterpart approval for the reviewed plan.
5. Do not enable shell tracing.

## Create the secret identity

1. Apply the exact approved Terraform plan through the protected workflow.
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
3. Confirm no ECS task definition references the reader secret yet.
4. Stop if any consumer already references the secret.

The indexer-role rollout is the next approved change. It creates the database
role, grants, verifier, and GraphQL secret injection.

## Failure handling

1. Do not delete the secret when the value is missing or incorrect.
2. Create a new version after the error is understood and approved.
3. Record the invalidated version identifier without recording the value.
4. Do not start the GraphQL reader until the later role verifier passes.
