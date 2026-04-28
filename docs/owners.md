# Cotsel Ownership Map

Snapshot date: 2026-04-28

## Purpose

Make review ownership visible without changing the monorepo shape or inventing a
heavy governance process. This file is the current ownership guide until real
GitHub team handles are confirmed for `CODEOWNERS`.

## Ownership Principles

- Ownership is by runtime boundary, not by future repo split.
- Owners are accountable for contract shape, tests, runbooks, and release
  evidence for their surface.
- Cross-boundary changes need review from each affected surface owner.
- Shared packages stay boundary-focused; they must not become hidden service
  domains.
- Security-sensitive actions also need the relevant security/ops reviewer, even
  when a service owner approves the functional change.

## Review Ownership

| Surface                    | Paths                                                                                                        | Primary review owner           | Required secondary review when touched                                           | Issue labels                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Contracts                  | `contracts/`, generated ABI usage in `sdk/src/types/typechain-types/`                                        | Contracts/protocol owner       | Security owner for access control, settlement, claim, or upgrade-sensitive edits | `area:contracts`, `type:security` when privileged    |
| Gateway                    | `gateway/`, `docs/api/cotsel-dashboard-gateway.openapi.yml`, gateway runbooks                                | Gateway/platform owner         | Downstream service owner for changed service contracts                           | `area:gateway`, `type:integration`                   |
| Auth                       | `auth/`, auth/session/admin-control docs                                                                     | Auth/security owner            | Gateway owner for session/capability contract changes                            | `area:security`, `area:backend`                      |
| Treasury                   | `treasury/`, treasury SOPs, payout/handoff/reconciliation-gate docs                                          | Treasury/finance owner         | Security owner for money movement, signer, evidence, or provider-boundary edits  | `area:treasury`, `area:payments`, `type:security`    |
| Oracle                     | `oracle/`, oracle redrive and programmability docs                                                           | Oracle/service owner           | Ops/security owner for retry, redrive, approval, or automation-control changes   | `area:oracle`, `area:ops-ci`                         |
| Ricardian                  | `ricardian/`, Ricardian SDK/client docs                                                                      | Ricardian/document owner       | Gateway owner when dashboard lookup contracts change                             | `area:ricardian`                                     |
| Reconciliation             | `reconciliation/`, reconciliation runbooks, staging reconciliation gates                                     | Reconciliation/ops owner       | Treasury owner for payout/handoff gate changes                                   | `area:reconciliation`, `area:ops-ci`                 |
| Indexer                    | `indexer/`, indexer schema/generated model usage, GraphQL freshness docs                                     | Indexer/data owner             | Gateway owner for dashboard read-model changes                                   | `area:indexer`, `type:integration`                   |
| SDK                        | `sdk/`, SDK docs, wallet/signing integration helpers                                                         | SDK/integration owner          | Contracts owner for ABI/state-machine changes; auth owner for session sequencing | `area:sdk`, `area:wallet`                            |
| Notifications              | `notifications/`, notification wiring scripts/docs                                                           | Notifications/ops owner        | Oracle/reconciliation owner when service alert behavior changes                  | `area:notifications`, `area:ops-ci`                  |
| Shared packages            | `shared-auth/`, `shared-db/`, `shared-edge/`, `shared-http/`                                                 | Platform/shared-boundary owner | Consuming service owner when the shared contract changes                         | `area:backend`, `type:integration`                   |
| CI, release, local startup | `.github/`, `scripts/`, `docker-compose.services.yml`, env examples, release/local-startup runbooks          | Ops/release owner              | Affected service owner for service-specific gates or compose behavior            | `area:ops-ci`, `area:docs-runbooks`                  |
| Production evidence docs   | `docs/runbooks/*evidence*`, incident templates, go/no-go docs, treasury/governance/signer/redrive procedures | Ops/security owner             | Treasury, gateway, oracle, or contracts owner based on action class              | `area:security`, `area:ops-ci`, `area:docs-runbooks` |

## Current `CODEOWNERS` Position

No repo-truth source currently identifies concrete GitHub users or teams for the
owner groups above. A `CODEOWNERS` file should be added only after those handles
are confirmed. Until then, this document is the explicit review map and issue
label guide.

## Review Routing Cheat Sheet

Use this when opening or reviewing a PR:

- `gateway/**`: request Gateway/platform owner; add the downstream service owner
  when response shape, authority semantics, or retry/error behavior changes.
- `auth/**`: request Auth/security owner; add Gateway/platform owner when
  session, role, capability, or signer authorization payloads change.
- `treasury/**`: request Treasury/finance owner; add Security/Ops owner for
  payout, sweep, handoff, signer, reconciliation-gate, or external-provider
  changes.
- `oracle/**`: request Oracle/service owner; add Ops/security owner for retry,
  redrive, manual approval, HMAC/replay, or automation changes.
- `contracts/**`: request Contracts/protocol owner; add SDK owner when ABI or
  generated type usage changes.
- `sdk/**`: request SDK/integration owner; add Auth/security owner for wallet or
  session sequencing and Contracts/protocol owner for ABI/state-machine changes.
- `shared-*`: request Platform/shared-boundary owner plus the first consuming
  service owner affected by the change.
- `.github/**`, `scripts/**`, env examples, and runbooks: request Ops/release
  owner plus any affected runtime service owner.

## PR Review Expectations

- A PR changing one surface should request review from that surface owner.
- A PR changing a gateway/downstream contract should request review from both
  gateway and the downstream service owner.
- A PR changing treasury, signer, governance, settlement, redrive, or production
  evidence behavior should include security/ops review.
- A PR changing shared packages should explain which services consume the change
  and why the logic belongs in shared code.
- A PR changing release/local-startup scripts should include the exact command
  used to validate the affected profile or gate.

## Non-Goals

- No team reorganization.
- No repo split.
- No formal approval board.
- No fake `CODEOWNERS` entries without real GitHub handles.
