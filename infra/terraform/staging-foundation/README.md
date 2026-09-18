# Cotsel staging foundation

This Terraform root owns the narrow infrastructure that must exist before a
release image or managed signer can be activated. It owns the `cotsel/relayer`
ECR repository and the isolated Oracle and relayer custody identities. The
eight existing repositories remain owned by the historical `staging-platform`
state. This root reads them only to verify the complete release cohort.

The root creates two non-exportable `ECC_SECG_P256K1` KMS keys, stable aliases,
and dedicated ECS task roles. It does not grant `kms:Sign`, deploy ECS tasks,
change contract configuration, activate a signer, enable gasless execution, or
manage secret values. Plan and apply it only through
`.github/workflows/terraform.yml` with `root=staging-foundation`. The apply must
consume the exact reviewed saved-plan version.

After apply, verify repository immutability, KMS encryption, scan-on-push,
lifecycle policy, CloudTrail actor, and Terraform outputs. Then rerun the full
Release Images workflow from the intended source commit. An empty repository
by itself is not release evidence; the relayer image must be built, scanned,
signed, attested, and published by immutable digest.

After signer-custody apply, retrieve each public key through an approved
read-only identity. Derive each EVM address twice. Record the key ARN, alias,
algorithm, address, and verification evidence. Do not generate or import raw
private-key material. Do not create a runtime plan until both addresses are
independently verified.
