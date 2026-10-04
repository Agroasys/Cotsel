# AWS staging platform

## Purpose

Use this procedure to plan, review, apply, verify, and roll back the Cotsel
staging platform in the existing Agroasys AWS account. This procedure implements
the platform boundary for WP-7. It does not accept WP-7 or authorize a release.

## Preconditions

1. Confirm AWS account `655177116834` and region `ap-south-1`.
2. Confirm the approved monthly budget and alert recipients.
3. Confirm the Agroasys `staging-network` and `staging-data` state roots exist.
4. Confirm an `ap-south-1` ACM certificate covers the private CloudFront origin
   hostname and record its non-secret ARN in the reviewed plan inputs.
5. Confirm the Cotsel deployment job uses GitHub OIDC and a protected staging
   environment. Do not use a long-lived AWS key.
6. Confirm the candidate references signed image digests. Do not use mutable
   image tags.
7. Confirm #639 supplies the exact Base Sepolia contract identity. Do not reuse
   the historical address as candidate evidence.
8. Confirm the Agroasys `staging-network` root enforces egress through AWS
   Network Firewall and approves every hostname in
   `infra/terraform/staging-platform/egress-destinations.json`. See
   [Egress enforcement](#egress-enforcement).

## Egress enforcement

The repository implementation can merge before firewall deployment and destination approval.
This does not authorize deployment. The plan must fail until all preconditions below pass.

Cotsel tasks share the Agroasys staging VPC. Their only internet path is
private subnet, then the same-zone Network Firewall, then NAT. The
`agroasys-backend` `staging-network` root owns that firewall and passes only the
TLS SNI hostnames approved in its `docs/readiness/wp2-staging-egress.json`.

Cotsel owns its own destination list in `egress-destinations.json`. The
`terraform_data.egress_enforcement_gate` precondition fails the plan when:

- the network output `egress_inventory.denied_by_default` is not `true`;
- an entry is still `unresolved` or is not a bare lowercase hostname;
- a required hostname is missing from the network's `approved_tls_names`.

The `gateway_https` and `services_https` security-group rules still allow TCP
443 to `0.0.0.0/0`, because a security group cannot match hostnames. Their
Trivy exceptions are valid only while this gate holds. Renew an exception only
with deployed evidence: an allowed flow for each destination and a dropped,
alerted flow to an unapproved hostname.

To add or change a destination:

1. Record the bare hostname in `egress-destinations.json`. Never record a URL,
   path, or API key.
2. Get the same hostname approved in the Agroasys staging contract and apply
   `staging-network`.
3. Plan this root. The gate passes only when both lists agree.

## Plan

1. Run the pull-request Terraform validation and security jobs.
2. Merge the reviewed Terraform change into `main`.
3. Dispatch the `plan` action from `main`.
4. Supply the reviewed `ap-south-1` origin certificate ARN.
5. Check the account, region, state key, additions, changes, and deletions.
6. Stop if the plan changes a shared Agroasys resource.
7. Confirm the state bucket reports versioning status `Enabled`; the workflow
   must fail before upload if it is disabled or suspended.
8. Record the non-null S3 object version and SHA-256 digest.
9. Request independent approval before the plan is 24 hours old.

## Apply

1. Dispatch the `apply` action from the same `main` commit.
2. Supply the approved plan run ID.
3. Supply the approved S3 object version ID.
4. Use a different person from the plan dispatcher.
5. Approve the protected `staging` environment deployment.
6. Verify the plan metadata and SHA-256 digest.
7. Apply the verified plan without regeneration.
8. Record the run ID, source commit, plan digest, state serial, reviewer, and non-secret output ARNs.

## Verification

After runtime promotion, verify all of the following against the same release:

1. The external edge exposes only the approved gateway path.
2. Direct ALB access is unavailable outside the VPC.
3. Every task runs an immutable digest and the expected source commit.
4. Runtime containers are non-root, use read-only filesystems where supported,
   and drop Linux capabilities.
5. Database and Redis endpoints are private.
6. A valid Agroasys signed settlement request succeeds.
7. An invalid signature fails.
8. A repeated nonce fails.
9. The signed callback reaches Agroasys exactly once.
10. Primary RPC failure moves safely to the independent fallback.
11. Readiness removes traffic when a required financial dependency fails.

Store redacted proof in the release evidence bundle. Never store credentials,
tokens, full connection strings, or customer data in evidence.

## Rollback

1. Stop new settlement commitments.
2. Keep the current GCP staging route unchanged until AWS acceptance.
3. If AWS verification fails before cutover, remove the AWS candidate from the
   edge and keep GCP active.
4. If verification fails after cutover, restore the last approved edge origin.
5. Do not destroy the failed AWS deployment until logs, database state, queue
   state, chain outcomes, and callback outcomes are reconciled.
6. Record the decision, incident owner, release identities, and reconciliation
   result before resuming traffic.

GCP decommissioning is a separate destructive change. It requires explicit
approval after AWS evidence is independently accepted.

Use the [GCP to AWS staging cutover](gcp-to-aws-staging-cutover.md) procedure
to establish state parity, perform the controlled traffic cutover, and prepare
decommission evidence.
