# Release candidate manifest and evidence index

This runbook defines the machine-readable records that bind Cotsel readiness evidence to an exact
release candidate. It also defines the rules that CI enforces. It implements SOW rows REPORT-02 and
PROG-01 under work package WP-0
([#636](https://github.com/Agroasys/Cotsel/issues/636), gate E-0).

The programme verdict is **NO-GO**. These contracts describe how evidence is bound and accepted.
They do not authorize a rehearsal, pilot or mainnet release, and no candidate is pinned yet.

## Records and schemas

| Record or schema                                       | Version                                 | Owner                                                 |
| ------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------- |
| `integration/release-candidate-inventory.json`         | `cotsel.release-candidate-inventory.v1` | Release Owner and Platform                            |
| `integration/candidate-manifest.v2.schema.json`        | `cotsel.candidate-manifest.v2`          | Release Owner                                         |
| `integration/evidence-index.schema.json`               | `cotsel.evidence-index.v1`              | Release Owner, with Security and Operations reviewers |
| `integration/candidate-manifest.schema.json` (history) | `cotsel.candidate-manifest.v1`          | Release Owner                                         |

The **release candidate inventory** lists every required artifact and migration owner. CI compares
this inventory with Terraform, release workflows, and migration manifests.

The **candidate manifest** identifies one deployable release candidate. It records the source,
artifacts, migrations, chain, contract, configuration, approvals, and rollback target. It includes
the digest of `integration/release-manifest.json`. Therefore, sibling repository pins are part of
the candidate identity.

The **evidence index** maps SOW control identities to reproducible artifacts. Every entry records
the identity it was produced against, who produced it, and who accepted it.

Candidate manifest version 1 is historical. The validator reads it only with `superseded` status.
Version 1 cannot authorize new evidence.

## Required release candidate inventory

The inventory is closed. A candidate must contain every required entry and no additional entry.

The Cotsel image set is `auth`, `gateway`, `indexer-graphql`, `indexer-pipeline`, `oracle`,
`reconciliation`, `relayer`, `ricardian`, and `treasury`.

The cross-repository set is `@agroasys/sdk`, `AgroasysEscrow`, `agroasys-backend`, `platform.v1`,
and `Cotsel-Dash`.

The migration set is `auth`, `gateway`, `indexer`, `oracle`, `reconciliation`, `ricardian`, and
`treasury`.

Each artifact records its digest, source commit, producing workflow, provenance, SBOM status, and
verification result. Container images also use digest references. Each migration records its head
and checksum.

## Candidate identity, and what may change without invalidating evidence

The identity digest covers only the dimensions that can change what a run proves:

```
candidateId, sourceCommit, crossRepositoryManifestSha256, artifactDigests, environment,
chainId, contractAddress, contractAbiSha256, contractDeployedBytecodeSha256,
migrationIdentities, providerMode, configDigestSha256
```

An artifact identity digest covers the complete artifact record. A provenance, workflow, source,
SBOM, or verification change therefore changes the candidate identity.

Lifecycle fields such as `status`, `approvals`, and rollback notes are excluded. Promotion does not
invalidate evidence for the same candidate. A change to an identity field creates a new candidate.

Compute the digest with:

```bash
node scripts/check-release-evidence-binding.mjs --manifest <candidate-manifest.json>
```

## Rules CI enforces

`pnpm run release:evidence:check` runs inside `ci/repo-quality`. It fails closed on all of the
following.

**Binding**

- The index `candidateId` matches the manifest, and `manifest.sha256` equals the candidate identity
  digest. Evidence bound to another build is rejected.
- The environment report carries the same identity digest and the same redacted configuration
  digest as the manifest (PROG-01).
- Every entry's `boundIdentity` equals the manifest on all nine dimensions REPORT-02 names:
  `sourceCommit`, `artifactDigests`, `environment`, `chainId`, `contractAddress`,
  `contractDeployedBytecodeSha256`, `migrationIdentities`, `providerMode`, `configDigestSha256`.

  `artifactDigests` contains full artifact identity digests for version 2 candidates.
  `migrationIdentities` includes each migration checksum.

  `contractDeployedBytecodeSha256` is recorded per entry because an address is not an
  implementation: a proxy upgrade keeps the address by design, and the same source compiled with a
  different solc version or optimizer setting keeps both the address and the commit. Without it,
  evidence produced against the old implementation would bind to the new candidate unchallenged.
  `contractAbiSha256` is not a separate dimension — any ABI difference that changes behaviour
  changes the deployed bytecode with it, and an ABI difference that leaves the bytecode identical
  is metadata only.

**Acceptance**

- An entry accepted by its own producer is rejected; the other named programme participant reviews it.
- An equivalence accepted by the producer of the evidence it waives is rejected on the same rule. A
  waiver is the more consequential decision, so it cannot carry less separation than the acceptance
  it bypasses. The reviewer of an entry **may** accept its equivalence: evidence produced by one
  person and waived by another is still two people.
- A reviewer must hold one of `Release Owner`, `Security reviewer` or `Operations reviewer`.
- For `base-sepolia-staging`, `integration/release-authority-profile.json` binds those roles to
  `astton` and `czpyioe`. It also requires evidence produced by either person to be reviewed by the
  other person. The profile permits only named automation identities to produce automated evidence.
- Every actor identity — `approvals[].identity`, `producedBy.identity`, `reviewer.identity` and
  `equivalence.acceptedBy` — must be a canonical handle: lowercase, no whitespace, 2 to 64
  characters, matching `^[a-z0-9][a-z0-9._@/+-]{1,63}$`. Separation of duties is decided by string
  equality on these fields, so one person must not be nameable as `avitus`, `AvitusI` and
  `Avitus I`. Use the same handle a person holds in `approvals`.
- Acceptance is checked only when the required control set is named:
  `--require-controls REPORT-02,PROG-01` calls `assertEvidenceIndexComplete` and fails closed on
  any control with no `accepted` entry. Without the flag the command validates **binding only** —
  an index whose every entry is still `pending` is correctly bound and not accepted, and the
  summary line reports both counts.
- Only a `candidate` or `promoted` manifest may bind evidence. A `draft` must name its activation
  blockers; a `superseded` candidate accrues nothing further.
- `promoted` requires an `approved` decision from all three roles.

**Boundaries**

- Outside `base-mainnet`, `publicParticipants` and `realCommercialValue` must be false (ENV-01,
  ENV-02), and each environment may only declare its own classifications.
- `chain.chainId` and `environment.name` must agree about Base mainnet in both directions.
- The configuration digest must be marked redacted. No raw configuration, secret or participant
  data enters either document.

## Accepted equivalence

Evidence may be reused across a changed dimension only with an explicit equivalence record naming
the dimensions, the accepting authority and role, the rationale, and an expiry:

```json
"equivalence": {
  "dimensions": ["configDigestSha256"],
  "acceptedBy": "release-owner@example.invalid",
  "role": "Release Owner",
  "rationale": "Log verbosity only; no settlement, signer or provider setting changed.",
  "expiresAt": "2026-09-01T00:00:00.000Z"
}
```

The validator rejects an expired equivalence, one that covers a dimension that did not actually
differ, one that covers a different dimension than the one that drifted, and one whose `acceptedBy`
is the producer of the entry.

**Not waivable:** equivalence across the Base mainnet boundary. Rehearsal evidence from Base
Sepolia can never be carried onto Base mainnet by equivalence — ASSUMPTION-03 and ENV-04 require a
fresh WP-12 packet.

## Producing a candidate

1. Build and publish every required artifact.
2. Record each immutable artifact digest.
3. Verify each provenance record and required SBOM.
4. Record every migration head and checksum.
5. Record the deployed contract identity from its deployment report.
6. Update `integration/release-manifest.json` when a sibling pin changes.
7. Record the canonical release manifest digest in the candidate manifest.
8. Run the cross-repository binding check.
9. Produce the redacted configuration inventory and digest.
10. Produce the environment report.
11. Confirm that the authority profile permits the environment.
12. Add evidence after each control produces proof.
13. Obtain the required independent evidence decision.
14. Run the acceptance check with the required controls:

```bash
node scripts/check-release-evidence-binding.mjs \
  --manifest <candidate-manifest.json> \
  --index <evidence-index.json> \
  --require-controls <CONTROL,CONTROL>
```

Without `--require-controls`, the command reports `acceptance not checked`. “Evidence index valid”
means “bound to this candidate.” It does not mean “accepted.”

Fixtures showing a complete, valid pair are in `scripts/tests/fixtures/release-evidence/`. They are
test data, not a pinned candidate, and no value in them is release evidence.

## Release image supply-chain evidence

Audience: release, security, and platform operators.

Outcome: verify that each release image comes from the recorded source and contains a signed SBOM.

The release workflow publishes images only for a push to `main`. Pull requests build and scan the
same Dockerfiles, but they do not publish images or create release attestations.

A retry may reuse an image already published for the exact source commit. It must not create fresh
build provenance for an image that the retry did not build. The retry verifies the existing signed
provenance against the exact main workflow identity and source digest, carries the certificate's
immutable producing-run URI into the evidence record, and creates and verifies a fresh signed SBOM
for the current scan. More than one eligible producing-run URI is an ambiguity and fails closed.

The publishing job must produce these records for every service image:

- an immutable ECR image digest;
- a fixable high and critical vulnerability scan;
- an SPDX 2.3 JSON SBOM;
- a signed SLSA build-provenance attestation;
- a signed SBOM attestation;
- the Sigstore bundles for both attestations; and
- JSON output proving that the workflow verified both signatures.

The repository policy check fails when an external action, Docker base image, Compose image, or CI
service image uses a mutable reference. It also requires Node `22.23.2` in the release toolchain.
Run it locally with:

```bash
corepack pnpm run release:supply-chain:check
```

Before verification, complete these prerequisites:

- Authenticate the GitHub CLI.
- Authenticate to the applicable ECR registry with pull-only access.
- Get the exact source commit and image digest.

After a successful `main` build, download the workflow evidence. Then verify the published digest
independently. Do not put registry credentials in the command or evidence record.

```bash
gh run download <release-images-run-id> \
  --repo Agroasys/Cotsel \
  --dir <evidence-directory>

gh attestation verify \
  'oci://<registry>/<repository>@sha256:<image-digest>' \
  --repo Agroasys/Cotsel \
  --cert-identity \
    'https://github.com/Agroasys/Cotsel/.github/workflows/release-images.yml@refs/heads/main' \
  --source-ref refs/heads/main \
  --source-digest <source-commit> \
  --deny-self-hosted-runners

gh attestation verify \
  'oci://<registry>/<repository>@sha256:<image-digest>' \
  --repo Agroasys/Cotsel \
  --cert-identity \
    'https://github.com/Agroasys/Cotsel/.github/workflows/release-images.yml@refs/heads/main' \
  --source-ref refs/heads/main \
  --source-digest <source-commit> \
  --predicate-type https://spdx.dev/Document/v2.3 \
  --deny-self-hosted-runners
```

Record the source commit, producing run ID, repository, image digest, attestation IDs, and artifact
checksums in the candidate evidence. Do not record authenticated registry URLs, tokens, or the ECR
login password.

Digest updates are deliberate release changes. Use this procedure:

1. Resolve the new upstream digest.
2. Verify the image publisher and target platform.
3. Update all governed references together.
4. Run the full release matrix.
5. Obtain exact-head review.

Do not replace a digest with a floating tag.

## Open dependencies

The contracts are complete, but two WP-0 inputs remain unapproved and no candidate can be pinned
until they land:

| Dependency                                                             | Effect                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#635](https://github.com/Agroasys/Cotsel/issues/635) `wp0-charter`    | Fixes the environment owner, provider mode, participant class and value caps a real candidate must declare.                                                                                                                                     |
| [#637](https://github.com/Agroasys/Cotsel/issues/637) `wp0-governance` | Supplies the decision log and defect policy that record an equivalence acceptance and its revocation trigger outside this file: `docs/readiness/cotsel-governance-register-v1.md` §3 and §4, logged in `docs/readiness/cotsel-decision-log.md`. |

The seven journeys specified in `docs/readiness/cotsel-golden-journeys-v1.md`
([#638](https://github.com/Agroasys/Cotsel/issues/638)) bind their runs through this contract.

## Change and invalidation rule

A change to any identity dimension produces a new candidate and invalidates evidence bound to the
previous one. A change to these schemas or to the enforced rules requires Release Owner, Security
and Operations review, and reopens any acceptance that relied on the previous contract.
