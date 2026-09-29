# GitHub Actions optimization baseline

## Status

This document records the CI architecture at commit
`139c74a15a262d6e56b9a4a55010fb08f5d924c8`. It is a historical snapshot, not
a statement about the current `main` branch.

This repository is public. GitHub fully discounted the observed standard Linux runner
usage. The workflow architecture remains important because it protects settlement,
treasury, release, image, and infrastructure boundaries.

This baseline changes no workflow behavior and enables no validation suppression.

## Repository and governance

| Field                      | Value                                                                       |
| -------------------------- | --------------------------------------------------------------------------- |
| Repository                 | `Agroasys/Cotsel`                                                           |
| Visibility                 | Public                                                                      |
| Default branch             | `main`                                                                      |
| Branch protection observed | `main` returned `Branch not protected` through the GitHub API on 2026-09-29 |
| Cost priority              | Low for private-minute reduction; high for assurance review                 |

The unprotected default branch is a release-integrity concern. This baseline does not change
repository settings. Resolve that concern through an independently approved governance change.

## Workflow inventory at the snapshot commit

| Workflow                                  | Trigger                                   | Maximum runner job executions | Purpose                                                                                  |
| ----------------------------------------- | ----------------------------------------- | ----------------------------: | ---------------------------------------------------------------------------------------- |
| Archive Base Sepolia Evidence             | Manual                                    |                             1 | Archive exact Base Sepolia evidence                                                      |
| Contract Deployment Evidence              | Manual                                    |                             1 | Deploy and retain exact contract evidence                                                |
| Production-Readiness Project Governance   | Issues, selected pushes, schedule, manual |                             1 | Keep readiness project state consistent                                                  |
| Cross-repository compatibility            | Reusable call, manual                     |                             1 | Verify paired consumer/provider compatibility                                            |
| DCO Check                                 | PR                                        |                             1 | Enforce signed-off commits                                                               |
| KMS Signer Address Evidence               | Manual                                    |                             1 | Derive controlled signer evidence                                                        |
| PR Roadmap Policy                         | PR metadata and update events             |                             1 | Enforce roadmap metadata                                                                 |
| CI Release Gate                           | PR, push to `main`                        |                            20 | Change classification, component validation, security, runtime, recovery, and final gate |
| Release Images                            | PR, push to `main`, manual                |                            10 | Registry preflight plus nine service image builds, SBOMs, scans, and evidence            |
| Roadmap PR Closeout Sync                  | Merged PR close, manual                   |                             1 | Update roadmap state after merge                                                         |
| Historical Roadmap Weighted Progress Sync | Manual                                    |                             1 | Maintain archived progress reporting                                                     |
| Runtime Containment Evidence              | Manual                                    |                             1 | Recheck exact runtime containment boundaries                                             |
| SDK Publish                               | Manual                                    |                             1 | Publish the exact reviewed SDK version                                                   |
| Terraform                                 | Selected PR paths, manual plan/apply      |                     2 on a PR | Format, validate, security, plan, and guarded apply                                      |

This column counts runner-backed job executions in one workflow run. It does not count a
reusable-workflow caller as an additional runner. The two compatibility jobs are mutually
exclusive because one runs for Dependabot and the other runs for all other actors.

Dependabot, CodeQL, and GitHub Code Quality also run as GitHub-managed workflows.

## Pull-request execution map

An ordinary PR can start:

- DCO Check.
- PR Roadmap Policy.
- CI Release Gate.
- Release Images.
- GitHub-managed CodeQL or dependency workflows when eligible.

The CI Release Gate has an always-running change classifier and final aggregate gate. It
conditionally runs component checks for auth, gateway, contracts, SDK, oracle, indexer,
notifications, reconciliation, Ricardian evidence, and treasury.

The maximum first-party runner count is approximately 32 job executions before Terraform.
A Terraform-path change can add two PR jobs. Conditional classification normally reduces
the CI Release Gate subset.

## Concurrency and filtering

DCO, roadmap policy, CI Release Gate, and Release Images cancel superseded PR work. Mainline
and evidence-producing work does not use PR cancellation.

Terraform uses path filters for its workflow, infrastructure roots, and Base Sepolia
contract evidence. Its concurrency does not cancel plan or apply work.

Release Images has no path filter and can build all nine service images on a normal PR.
Because this repository is public, that breadth is primarily an engineering-feedback and
environmental-efficiency concern rather than a private-minute billing concern.

## Security and release boundaries

The CI Release Gate uses capability-like component outputs and an `always()` aggregate job.
Unknown or shared changes can request the full matrix.

Release Images builds service images, generates SBOM and vulnerability evidence, and binds
release evidence to image digests. Do not replace these controls with package-manager audit.

Terraform separates PR validation and security from manual plan and apply. Preserve plan
identity, destructive-change controls, protected environments, and exact apply inputs.

Roadmap PR Closeout Sync uses `pull_request_target` only for a merged/closed event. It does
not check out or execute PR code. Preserve that restriction if the workflow changes.

## Observed usage and billing

The workflow-run query covers `2026-08-28T00:00:00Z` through
`2026-09-27T16:20:56Z`, inclusive. It uses each workflow's runs endpoint with the exact
`created` range and `per_page=1`, then records `total_count`.

| Workflow          | Runs |
| ----------------- | ---: |
| PR Roadmap Policy |  581 |
| Release Images    |  395 |
| CI Release Gate   |  389 |
| DCO Check         |  352 |
| Terraform         |  162 |

The enhanced billing API was rechecked on 2026-09-29. For `Agroasys/Cotsel`, records dated
from 2026-09-01 through 2026-09-27 report 25,113 Linux minutes, USD 150.678 gross cost,
USD 150.678 discount, and USD 0 net cost. Actions storage also reports USD 0 net cost.

GitHub can backfill billing usage after the initial observation. The earlier 24,861-minute
figure was provisional and is not retained as the verified baseline value.

## Phase 0 findings

1. Do not prioritize this repository for private Actions billing reduction.
2. Preserve its broad financial, settlement, treasury, recovery, and release controls.
3. Review Release Images eligibility later for developer feedback and resource efficiency.
4. Keep the CI Release Gate classifier fail-closed and test unknown paths and renames.
5. Treat default-branch protection as a separate governance issue.
6. This baseline enables no validation suppression.

## Rollback

Revert this documentation commit if the baseline contains an error. No CI behavior rollback
is required.
