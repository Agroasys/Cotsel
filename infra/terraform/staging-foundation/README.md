# Cotsel staging foundation

This Terraform root owns the narrow infrastructure that must exist before a
release image or managed signer can be activated. It owns the `cotsel/relayer`
ECR repository, the isolated Oracle and relayer custody identities, and the
absent zero-runtime prerequisites identified by the live reconciliation plan:
execution/task roles, narrowly scoped execution policies, reader/notification
secret identities, the relayer log group, Cloud Map service identities, and
the network rules needed by the separated services. The eight existing
repositories and all historical runtime resources remain owned by the
`staging-platform` state.

The root creates two non-exportable `ECC_SECG_P256K1` KMS keys, stable aliases,
and dedicated ECS task roles. It does not grant `kms:Sign`, register task
definitions, create or update ECS services, change contract configuration,
activate a signer, enable gasless execution, or manage secret values. Plan and
apply it only through
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

The runtime-prerequisite resources are intentionally in this state because the
diagnostic platform plan proved they do not yet exist in the historical
platform state. Do not move an existing resource into this root without a
separately reviewed state-migration plan. Apply this root first, verify every
created identity and policy live, and only then generate a fresh
`staging-platform` runtime-convergence plan.
