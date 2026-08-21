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

After apply, record the workflow run, plan hash, state serial, non-secret output
ARNs, CloudFront distribution domain, reviewer, and timestamp. Then update the
external DNS record for `cotsel.sys.agroasys.com` to the CloudFront distribution
domain and run the live HMAC proof set. An apply is foundation evidence only; it
does not close #667 or authorize a candidate.
