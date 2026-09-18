# Cotsel staging foundation

This Terraform root owns the narrow infrastructure that must exist before a
release image can be published. Its first responsibility is the missing
`cotsel/relayer` ECR repository. The eight existing repositories remain owned
by the historical `staging-platform` state and are read here only to verify the
complete release cohort.

The root does not deploy ECS tasks, change contract configuration, activate a
signer, enable gasless execution, or manage secret values. Plan and apply it
only through `.github/workflows/terraform.yml` with `root=staging-foundation`.
The apply must consume the exact reviewed saved-plan version.

After apply, verify repository immutability, KMS encryption, scan-on-push,
lifecycle policy, CloudTrail actor, and Terraform outputs. Then rerun the full
Release Images workflow from the intended source commit. An empty repository
by itself is not release evidence; the relayer image must be built, scanned,
signed, attested, and published by immutable digest.
