# WP-6 completion procedure

## Purpose and ownership

Use this procedure to complete WP-6 repository controls, governance, evidence binding, operational drills, and independent acceptance.
The audience is Cotsel release engineers, repository administrators, and the named Engineering, Security, Release, and Operations reviewers.

The working lead is @czpyioe. The delivery reviewer is @Astton.
An evidence producer must not accept their own evidence.
Use the [authority profile](../../integration/release-authority-profile.json) for candidate approval and evidence review.
Record a deputy decision before another reviewer accepts evidence outside that profile.

The canonical status ledger is [WP-6 #628](https://github.com/Agroasys/Cotsel/issues/628#issuecomment-6060804583).
Update that comment after each batch. Do not create competing completion trackers.

This procedure permits private Base Sepolia preparation. It does not authorize cloud changes, signing, a controlled pilot, or Base mainnet.

## Prerequisites

Confirm these prerequisites before execution:

- A clean worktree at the selected reviewed source.
- The Node version from `.nvmrc` and pnpm version from `package.json`.
- Authenticated read access to repository rules, protected environments, workflow permissions, and required evidence.
- Named producers and independent reviewers for each requirement.
- Operation-specific decisions for settings, infrastructure, signing, publication, and promotion.

## Batch 1: Requirement ledger

1. Recheck the source head and live child issues #662 through #666.
2. Map every primary and contributor requirement to its acceptance route.
3. Record missing implementation, missing evidence, owners, reviewers, and the next decision date in #628.
4. Record the 14 artifacts and seven migration identities from the [candidate inventory](../../integration/release-candidate-inventory.json).

Do not equate nine image builds with a complete candidate.

## Batch 2: Repository controls

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Run the repository checks listed below.
3. Repair verified defects without weakening thresholds or package-age controls.
4. Obtain independent review of each final source head.
5. Merge only after required hosted checks and branch policy permit the exact head.
6. Verify final-main CI and image publication.

Run these checks from the repository root:

```bash
pnpm run lint
pnpm run typecheck
pnpm run format:check:full
pnpm run quality:file-size:check
pnpm run release:evidence:check
pnpm run release:supply-chain:check
pnpm run release:gate:check
pnpm run docs:integrity:check
pnpm run licenses:report
node --test scripts/tests/wp6-governance-policy.test.mjs scripts/tests/security-scan-evidence.test.mjs scripts/tests/sdk-release-evidence.test.mjs scripts/tests/license-inventory.test.mjs
```

The required CI aggregate includes repository secret scanning and Terraform scanning.
Seeded scanner tests must detect their findings. Scanner startup or download failures are failures, not seeded-test success.
Retained secret-scan reports contain identifiers and locations, not matched credentials or source payloads.

The license inventory must include every workspace and production dependency.
Unknown licenses require independent disposition. Inventory success does not establish legal acceptance or an approved license allowlist.

SDK publication runs from protected `main`. It packs validated output once and publishes that exact archive without lifecycle scripts.
Its signed SBOM describes the build workspace. It is not a claim that every workspace dependency ships inside the archive.
Registry integrity must match the attested package bytes.

## Batch 3: Governance packet and enforcement

1. Capture the current read-only settings packet.

```bash
node scripts/wp6-governance-audit.mjs --out /private/path/wp6-governance-packet.json
```

The command reads GitHub settings. It does not change settings.
The packet contains the before-state, proposed API payloads, violations, and proposal SHA-256.
The proposal preserves existing stronger checks and reviewer identities.

2. Record the packet hash and exact source in #665.
3. Obtain independent approval for the complete settings packet.
4. Recheck the before-state immediately before changing settings.
5. Apply the approved main ruleset payload without standing bypass actors.
6. Set read-only workflow defaults and disable workflow PR approval.
7. Enable immutable action SHA enforcement.
8. Disable administrator bypass on staging and both evidence environments.
9. Replace each environment's branch policies with the packet's exact `main` branch policy.
10. Capture and validate the returned settings.

```bash
node scripts/wp6-governance-audit.mjs --out /private/path/wp6-governance-after.json --require-compliant
```

Changing an environment's branch-policy mode does not remove old branch-policy records.
Delete obsolete records and create exactly one `main` branch policy. Do not permit tag or wildcard deployments.

11. Prove missing checks and independent review block a harmless probe PR.
12. Prove self-review and unauthorized deployment are rejected.
13. Verify hardware-backed privileged authentication and effective role separation.
14. Exercise temporary emergency access only in an approved disposable boundary.
15. Retain the approval, scope, expiry, incident review, and revocation record.

If a required context never runs, stop promotion and repair its routing.
Any settings recovery needs an independently reviewed decision. Do not silently restore standing bypasses.
Removing bypass actors does not remove an administrator's ability to edit settings; retain configuration-change audit and dual-control evidence.

## Batches 4 through 6: Custody, candidate, and deployed proof

1. Complete #673 through the [archive procedure](../../infra/terraform/base-sepolia-evidence-archive/README.md).
2. Prove separate writer and reader identities, denied mutations, retained versions, and confirmed alert delivery.
3. Obtain required staging, custody, contract, migration, recovery, and integration evidence from their owning issues.
4. Freeze the complete candidate through the [evidence-binding procedure](release-candidate-evidence-binding.md).
5. Independently verify registry signatures, provenance, SBOMs, checksums, and producing-run identities.
6. Obtain the exact candidate's protected promotion decision.
7. Deploy the verified artifact digests without rebuilding.
8. Record full-stack startup, readiness, lifecycle, replica-failure, outage, containment, and recovery results.
9. Execute the published deployment, incident, recovery, and reconciliation procedures.
10. Roll back application artifacts against the same verified contract.
11. Restore the selected candidate and verify its runtime identities.

Do not activate signer-capable services without accepted custody and role separation.
Use fresh approved Terraform plans. Never apply historical or retired plans.
Preserve legacy GCP state and historical artifacts.

A contract-address change requires the separate [contract-cohort rollback controls](contract-cohort-rollback.md).
Source or configuration changes invalidate affected evidence and require another candidate identity.

## Batch 7: Acceptance and closeout

1. Correct active runbooks using the procedures actually executed.
2. Obtain acknowledgement from every contributor acceptance route.
3. Validate evidence with the complete required control list.
4. Obtain each child's independent acceptance decision.
5. Obtain WP-6's independent package acceptance decision.
6. Close the accepted children and reconcile Project status.
7. Close #628 with the retained evidence packet and acceptance links.

Use `scripts/check-release-evidence-binding.mjs` with `--require-controls`.
A valid index without required-control acceptance is insufficient.
Missing evidence, unavailable access, absent authority, incompatible rollback, or unresolved release-blocking defects keep the package open.
