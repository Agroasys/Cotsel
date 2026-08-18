# Cotsel staging platform

This Terraform root creates the AWS-owned foundation for Cotsel WP-7 in the
existing Agroasys staging boundary. It does not deploy a release candidate.

## Ownership and boundaries

- AWS account: supplied explicitly through `account_id` and verified at plan time.
- Workload region: `ap-south-1`.
- Terraform state: `s3://agroasys-tfstate-655177116834/cotsel/staging-platform/terraform.tfstate`.
- Network and managed data dependencies: read from the Agroasys
  `staging-network` and `staging-data` state roots.
- Public ingress: none. The ALB is internal and admits only the AWS-managed
  CloudFront origin prefix list.
- Runtime promotion: intentionally absent until signed image digests, database
  migration identity, configuration digest, Base Sepolia RPC pair, managed
  signer, and the contract record from #639 are pinned.

## Secret handling

Terraform creates named Secrets Manager resources but never a secret version.
Populate and rotate values through the protected deployment workflow. Do not
pass secret values in `*.tfvars`, workflow inputs, plans, logs, GitHub, or chat.

Task E uses these two identities:

- `/agroasys/staging/cotsel/gateway-settlement-ingress`
- `/agroasys/staging/cotsel/gateway-settlement-callback`

The first stores the Agroasys-to-Cotsel API key set used to render
`GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON`. The second stores the distinct
Cotsel-to-Agroasys callback key and secret. They must not share a credential.

Database runtime and migration identities are also separate for every database
owner. Each service-auth boundary and each managed signer has its own secret
identity. A task role receives only the ARNs required for that service; the
runtime delivery root enforces that mapping when task definitions are added.

## Validation

```bash
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/staging-platform init -backend=false
terraform -chdir=infra/terraform/staging-platform validate
```

The pull-request workflow also scans the root for High and Critical Terraform
misconfiguration findings.

## Apply prerequisites

Do not apply this root until all of the following are true:

1. `staging-network` and `staging-data` have been applied in `ap-south-1`.
2. A validated `ap-south-1` ACM certificate exists for the private origin hostname.
3. The protected Cotsel GitHub deployment environment and AWS OIDC role exist.
4. The reviewed plan contains no replacement or deletion of shared Agroasys resources.
5. The monthly AWS budget and alert recipients are approved.
6. A different person approves the exact plan that the protected job applies.

After apply, record the workflow run, plan hash, state serial, non-secret output
ARNs, reviewer, and timestamp. An apply is foundation evidence only; it does not
close #667 or authorize a candidate.
