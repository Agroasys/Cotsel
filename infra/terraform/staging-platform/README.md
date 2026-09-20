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
- Edge controls: the CloudFront distribution uses a `us-east-1` WAF web ACL. Managed
  rules begin in count mode, the IP rate rule blocks, and 30-day WAF and access logs redact
  gateway credentials and signatures.
- Runtime: the gateway and auth service share one private Fargate task. The
  indexer pipeline and GraphQL server share a second task. Reconciliation,
  Oracle, and relayer use independent services. Terraform resolves the reviewed
  commit tag for each service to its ECR digest before it creates a task definition.
- Deployment: every one-writer service uses a serialized `100/0` rollout.
  Indexer or reconciliation failure cannot terminate the gateway task. Gateway
  liveness remains observable while financial readiness fails closed when chain
  state is stale or unavailable.
- History: task definitions use `skip_destroy=true`. Terraform can register a
  reviewed revision without deregistering the historical revisions retained for
  incident evidence and rollback analysis.

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

The historical Oracle signer secret is not a permitted rollback signer. Keep it
only until consumer analysis and evidence preservation are complete. Then
revoke its authority and schedule deletion through the approved process.

The staging-foundation root creates two non-exportable `ECC_SECG_P256K1` KMS
keys and the absent zero-runtime prerequisites for the separated services. The
runtime root consumes those reviewed outputs; it does not duplicate their
Terraform ownership. The KMS keys cover only the Oracle and gasless relayer
identities because those roles have approved automated signing needs. Terraform
does not create KMS keys for the three human administrators, treasury, or
deployer.

Key creation does not grant signing access. Add each least-privilege runtime or
operator grant only after its derived EVM address is reviewed. Do not add a
treasury signer until its custody classification is approved. Use a separate
hardware-controlled wallet for deployment, then retire or restrict it. The
deployer must never receive a runtime role.

Use the stable aliases from `managed_signer_aliases`. Derive each public address
with `GetPublicKey`; never create or import plaintext private key material.

The accepted staging contract uses distinct approved Oracle, treasury, relayer,
and administrator addresses. The three administrators must be independent
hardware-backed wallets in the direct prepare, review, sign, broadcast, and
confirm flow; they must not be KMS aliases or backend-accessible signers. The
deployer must not hold a runtime role.

Keep signer services disabled during key creation. Reconstruct and verify the
accepted contract evidence before enabling KMS-backed runtime signing.

The Oracle runs as its own ECS service and task role. The gateway task cannot
read the Oracle database credential or any Oracle signing material, and only
the Oracle task role can call `kms:GetPublicKey` and `kms:Sign` on the Oracle key.
Oracle reads the isolated indexer through private Cloud Map DNS; gateway-to-
Oracle calls remain authenticated with the existing service credential.

The gasless relayer also runs as its own ECS service and task role. Only that
task role can sign with the relayer key. The gateway sends HMAC-authenticated,
intent-bound requests and independently verifies the returned transaction. The
gateway has no KMS key ID, KMS SDK dependency, or `kms:Sign` permission. Both
signer policies permit only `DIGEST` with `ECDSA_SHA_256`; cross-role signing is
explicitly denied, and ECS Exec is disabled for both signer workloads.

KMS activation uses separate foundation and runtime plans:

1. Apply the reviewed staging-foundation plan.
2. Derive both EVM addresses with `GetPublicKey` under a scoped read-only identity.
3. Independently verify both addresses.
4. Set `COTSEL_STAGING_ORACLE_KMS_EXPECTED_ADDRESS` to the reviewed Oracle address.
5. Set `COTSEL_STAGING_RELAYER_KMS_EXPECTED_ADDRESS` to the reviewed relayer address.
6. Populate the protected `gateway-managed-signer` service-auth secret.
7. Review a fresh zero-count plan from `main` and confirm each role can access only its own key.
8. Apply that exact plan without activating either signer.
9. Set a signer desired-count variable to `1` only after its independent custody gate passes.
10. Review and apply that signer-specific activation plan.
11. Capture startup, wrong-address, denial, signing, CloudTrail, and reconciliation evidence.

An empty Oracle address keeps the Oracle service stopped and supplies no signer
material. An empty relayer address keeps the relayer stopped and omits its
gateway credential. A reviewed address does not start a service: the matching
`COTSEL_STAGING_ORACLE_DESIRED_COUNT` or
`COTSEL_STAGING_RELAYER_DESIRED_COUNT` must also be set to `1`. Neither state
satisfies custody acceptance by itself. Keep `gasless_execution_enabled=false`
until the durable nonce migration, one-writer topology, signing denials, and
Base Sepolia rehearsal have been accepted. Terraform rejects enabling gasless
execution with more than one gateway writer.

Runtime recovery uses separate saved plans. Set
`COTSEL_STAGING_INDEXER_DESIRED_COUNT=1` first and verify migration state,
provider health, and catch-up. Next set
`COTSEL_STAGING_RECONCILIATION_DESIRED_COUNT=1` and verify reconciliation.
Only then set `COTSEL_STAGING_GATEWAY_DESIRED_COUNT=1`. Oracle and relayer stay
at zero until their custody gates pass; Ricardian and Treasury use their own
desired-count variables and preflights. Change one activation stage at a time
and never reuse a plan created against an earlier state.

Every service schema migration runs as a separate one-off ECS task. Each
execution role can pull only its service image, write only its service log
group, and read only its service migration credential. Long-running execution
roles cannot read migration credentials. Long-running services do not execute
schema migrations.

Every runtime, migration, bootstrap, and verifier container has a read-only root
filesystem. Each container receives only an ephemeral writable `/tmp` mount.
The gateway/auth and indexer pipeline/GraphQL task pairs use separate volumes so
one container cannot read another container's temporary files.

The indexer migration task executes the migration binary already present in
the immutable image. It does not invoke a removed package-manager shim or
download tooling at runtime.

Run each one-off task without command overrides. After deployment, confirm task
health, indexer progress, reconciliation progress, and the absence of filesystem
write errors before retiring the preceding task revisions.

Follow [`docs/runbooks/staging-indexer-migration.md`](../../../docs/runbooks/staging-indexer-migration.md)
for the indexer and
[`docs/runbooks/staging-service-migrations.md`](../../../docs/runbooks/staging-service-migrations.md)
for the other service databases. Run and verify required migrations before
deploying the corresponding long-running revision.

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
- one commit SHA whose immutable ECR tag exists in every repository in the
  authoritative runtime inventory.

After apply, record the workflow run, plan hash, state serial, non-secret output
ARNs, CloudFront distribution domain, reviewer, and timestamp. Then update the
external DNS record for `cotsel.sys.agroasys.com` to the CloudFront distribution
domain and run the live HMAC proof set. An apply is foundation evidence only; it
does not close #667 or authorize a candidate.
