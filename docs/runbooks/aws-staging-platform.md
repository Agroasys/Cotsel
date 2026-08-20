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
