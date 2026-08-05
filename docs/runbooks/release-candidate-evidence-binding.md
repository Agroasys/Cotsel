# Release candidate manifest and evidence index

This runbook defines the two machine-readable contracts that bind Cotsel readiness evidence to an
exact candidate, and the rules CI enforces on them. It implements SOW rows REPORT-02 and PROG-01
under work package WP-0 ([#636](https://github.com/Agroasys/Cotsel/issues/636), gate E-0).

The programme verdict is **NO-GO**. These contracts describe how evidence is bound and accepted.
They do not authorize a rehearsal, pilot or mainnet release, and no candidate is pinned yet.

## The two documents

| Document                                     | Schema                         | Owner                                                 |
| -------------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| `integration/candidate-manifest.schema.json` | `cotsel.candidate-manifest.v1` | Release Owner                                         |
| `integration/evidence-index.schema.json`     | `cotsel.evidence-index.v1`     | Release Owner, with Security and Operations reviewers |

The **candidate manifest** is the immutable identity of one deployable candidate: source commit,
artifact digests, migration heads, chain, contract address and ABI digest, provider mode, redacted
configuration digest, environment, approvals and rollback target. It also carries the digest of
`integration/release-manifest.json`, so the sibling-repository pins (`agroasys-backend`,
`platform.v1`, `Cotsel-Dash`) are part of the candidate identity rather than a parallel record.

The **evidence index** maps SOW control identities to reproducible artifacts. Every entry records
the identity it was produced against, who produced it, and who accepted it.

## Candidate identity, and what may change without invalidating evidence

The identity digest covers only the dimensions that can change what a run proves:

```
candidateId, sourceCommit, crossRepositoryManifestSha256, artifactDigests, environment,
chainId, contractAddress, contractAbiSha256, contractDeployedBytecodeSha256,
migrationIdentities, providerMode, configDigestSha256
```

Lifecycle fields — `status`, `approvals`, `supersedes`, `rollbackTarget` notes — are deliberately
excluded. Promoting a candidate from `candidate` to `promoted` therefore does **not** invalidate
evidence already accepted against it. Changing any identity dimension does, and produces a new
candidate.

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
- Every entry's `boundIdentity` equals the manifest on all eight dimensions REPORT-02 names:
  `sourceCommit`, `artifactDigests`, `environment`, `chainId`, `contractAddress`,
  `migrationIdentities`, `providerMode`, `configDigestSha256`.

**Acceptance**

- An entry accepted by its own producer is rejected; acceptance is four-eyes.
- A reviewer must hold one of `Release Owner`, `Security reviewer` or `Operations reviewer`.
- `assertEvidenceIndexComplete` reports any required control with no `accepted` entry. Delivery
  completion alone leaves a control unaccepted.
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
differ, and one that covers a different dimension than the one that drifted.

**Not waivable:** equivalence across the Base mainnet boundary. Rehearsal evidence from Base
Sepolia can never be carried onto Base mainnet by equivalence — ASSUMPTION-03 and ENV-04 require a
fresh WP-12 packet.

## Producing a candidate

1. Build and publish artifacts; record each image or package digest.
2. Record migration heads and checksums for every component with a schema.
3. Record the deployed contract identity from
   `contracts/reports/deploy/<network>/agroasysescrow-deploy.json` — address, ABI digest, deployed
   bytecode digest, compiler version and deployment transaction.
4. Update `integration/release-manifest.json` if any sibling pin changed, then embed its canonical
   digest in the candidate manifest. Verify with
   `node scripts/check-release-evidence-binding.mjs --manifest <path> --verify-cross-repository`.
5. Produce the redacted configuration inventory and its digest.
6. Emit the environment report carrying the identity digest and configuration digest.
7. Append evidence entries as each control produces proof, then have the named reviewer record a
   decision.

Fixtures showing a complete, valid pair are in `scripts/tests/fixtures/release-evidence/`. They are
test data, not a pinned candidate, and no value in them is release evidence.

## Open dependencies

The contracts are complete, but two WP-0 inputs remain unapproved and no candidate can be pinned
until they land:

| Dependency                                                             | Effect                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [#635](https://github.com/Agroasys/Cotsel/issues/635) `wp0-charter`    | Fixes the environment owner, provider mode, participant class and value caps a real candidate must declare.                     |
| [#637](https://github.com/Agroasys/Cotsel/issues/637) `wp0-governance` | Supplies the decision log and defect policy that record an equivalence acceptance and its revocation trigger outside this file. |

The seven journeys specified in `docs/readiness/cotsel-golden-journeys-v1.md`
([#638](https://github.com/Agroasys/Cotsel/issues/638)) bind their runs through this contract.

## Change and invalidation rule

A change to any identity dimension produces a new candidate and invalidates evidence bound to the
previous one. A change to these schemas or to the enforced rules requires Release Owner, Security
and Operations review, and reopens any acceptance that relied on the previous contract.
