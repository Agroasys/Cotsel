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
2. Create a speculative plan with the staging apply role.
3. Check the account, region, state key, additions, changes, and deletions.
4. Stop if the plan changes an Agroasys resource outside the Cotsel state root.
5. Save the plan as an immutable workflow artifact.
6. Record its SHA-256 digest and request independent approval.

## Apply

1. Use the protected staging environment.
2. Download the approved plan artifact from the producing workflow run.
3. Verify its SHA-256 digest.
4. Apply that plan without regenerating it.
5. Record the run ID, source commit, plan digest, state serial, reviewer, and
   non-secret output ARNs.

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
