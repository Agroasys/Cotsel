# Cotsel staging platform

This Terraform root creates the AWS-owned foundation for Cotsel WP-7 in the
existing Agroasys staging boundary. It does not deploy a release candidate.

## Ownership and boundaries

- AWS account: supplied explicitly through `account_id` and verified at plan time.
- Workload region: `ap-south-1`.
- Terraform state: `s3://agroasys-tfstate-655177116834/cotsel/staging-platform/terraform.tfstate`.
- Network and managed data dependencies: read from the Agroasys
  `staging-network` and `staging-data` state roots.
- Public ingress: `cotsel.sys.agroasys.com` terminates at CloudFront. CloudFront
  reaches the private ALB through a VPC origin; the ALB remains internal and
  admits only the AWS-managed CloudFront origin prefix list.
- Runtime: one private Fargate task bundles the gateway, auth, indexer pipeline,
  indexer GraphQL server, oracle, and reconciliation worker. Terraform resolves
  the reviewed commit tag for each service to its ECR digest before it creates a
  task definition.
- Deployment: the service uses a serialized `100/0` rollout because two bundled
  indexer processors cannot safely write the same status table concurrently.
  This causes a short staging interruption during task replacement.

## Secret handling

Terraform creates named Secrets Manager resources but never a secret version.
Populate and rotate values through the protected deployment workflow. Do not
pass secret values in `*.tfvars`, workflow inputs, plans, logs, GitHub, or chat.

Task E uses these two identities:

- `/agroasys/staging/cotsel/gateway-settlement-ingress`
- `/agroasys/staging/cotsel/gateway-settlement-callback`

The first stores the Agroasys-to-Cotsel API key set used to populate
`GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON`. The second stores the distinct
Cotsel-to-Agroasys callback key and secret. They must not share a credential.

The independent `gateway-to-treasury-auth` and `gateway-to-ricardian-auth`
secrets each hold one JSON object with `id`, `secret`, and boolean `active`
fields. The private service receives the full object as `API_KEYS_JSON`; ECS
injects only `id` and `secret` into the gateway for its signing client. Do not
store these singleton credentials as an array: the service parser accepts an
array for rotation, but ECS JSON-key injection into the gateway requires an
object. Add a separate, explicitly supported rotation mapping before changing
this representation.

Database runtime and migration identities are also separate for every database
owner. Each service-auth boundary and each managed signer has its own secret
identity. ECS injects the selected secret values before container startup, so
the task execution role can read only the required secret ARNs. The application
task role does not receive `secretsmanager:GetSecretValue`.

The oracle signer secret already exists at
`/agroasys/staging/base-sepolia/wallet-oracle`. Terraform reads its identity but
does not read or manage its value.

The indexer schema migration runs as a separate one-off ECS task. Its execution
role can pull only the indexer image, write only the indexer log group, and read
only the indexer migration credential. The long-running runtime role cannot read
that migration credential.

Follow [`docs/runbooks/staging-indexer-migration.md`](../../../docs/runbooks/staging-indexer-migration.md)
to run and verify the one-off migration without exposing credentials.

## Validation

```bash
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/staging-platform init -backend=false
terraform -chdir=infra/terraform/staging-platform validate
```

The pull-request workflow also scans the root for High and Critical Terraform
misconfiguration findings. Pull-request jobs receive no AWS identity. Live
plans run only through a manual dispatch from `main`.

## Apply prerequisites

Do not apply this root until all of the following are true:

1. `staging-network` and `staging-data` have been applied in `ap-south-1`.
2. A validated `ap-south-1` ACM certificate exists for the ALB origin hostname.
3. A validated `us-east-1` ACM certificate exists for
   `cotsel.sys.agroasys.com` so CloudFront can serve the public alias.
4. The protected Cotsel GitHub deployment environment and AWS OIDC role exist.
5. The reviewed plan contains no replacement or deletion of shared Agroasys resources.
6. The monthly AWS budget and alert recipients are approved.
7. A different person dispatches the exact plan that the protected job applies.

The plan dispatch also requires these non-secret release coordinates:

- reviewed Base Sepolia escrow address;
- escrow deployment block used by the indexer;
- reviewed Base Sepolia USDC address;
- one commit SHA whose immutable ECR tag exists in all six runtime repositories.

After apply, record the workflow run, plan hash, state serial, non-secret output
ARNs, CloudFront distribution domain, reviewer, and timestamp. Then update the
external DNS record for `cotsel.sys.agroasys.com` to the CloudFront distribution
domain and run the live HMAC proof set. An apply is foundation evidence only; it
does not close #667 or authorize a candidate.
