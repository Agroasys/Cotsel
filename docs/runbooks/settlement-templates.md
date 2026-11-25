# Settlement templates

Use this runbook to review the template registry rules and recover from a missing active version. It is for gateway engineers and settlement approvers.

Issue #940 covers the gateway template registry and the software development kit (SDK) module `settlementTemplate` in `@agroasys/sdk`. Migration `202611230017` adds the registry.

## Template terms

A settlement template is the authoritative record of these terms:

- the asset and its quantum, the smallest permitted amount increment
- the milestone release shares and the milestone that carries the supplier fee
- the buyer and supplier fees, the fixed support fee and the rounding rule
- the lock, transit, inspection and dispute windows

The pair `templateId` and `version` identifies a template version. `settlementTemplateHash` computes `templateHash` as the SHA-256 digest of the canonical JSON representation. JSON means JavaScript Object Notation.

Version 1 of `agroasys.launch` records the terms that the deployed escrow contract enforces through `LaunchSettlementSchedule` and the `AgroasysEscrow` window constants. Slice 1 (#963) verified these terms against the contract in Hardhat. Migration 017 seeds version 1 as active. It records `migration:017` as the author, reviewer and activator.

## Registry rules

The store and database enforce these rules:

| Rule                                                                                                                                                  | Control                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A version moves from `draft` to `reviewed`, then to `active`, then to `retired`. A `draft` or `reviewed` version can also move directly to `retired`. | The store and the `protect_settlement_template` trigger enforce these transitions.                                                                   |
| The reviewer and activator must each be someone other than the author.                                                                                | The store and the `settlement_templates_independent_*` constraints enforce this rule.                                                                |
| Each template has at most one active version.                                                                                                         | The `settlement_templates_one_active` index enforces this limit. The store retires the predecessor and activates the replacement in one transaction. |
| The terms, hash, author and recorded approvals are immutable. All versions must remain in the registry.                                               | The trigger protects these records. The runtime role has no `DELETE` permission.                                                                     |
| A stored template must match its hash.                                                                                                                | The store recomputes the hash on every read.                                                                                                         |
| Only versions with contract-enforced terms can become active.                                                                                         | The store's activation allowlist limits activation. The default is `agroasys.launch:1`.                                                              |
| The active version can retire only during its replacement.                                                                                            | The store refuses to retire the active version directly.                                                                                             |

The escrow contract uses a fixed `LaunchSettlementSchedule`. When #955 makes the contract read template terms, remove the allowlist.

## Template on each handoff

In the same statement, the handoff insert reads `template_id`, `template_version` and `template_hash` from the active `agroasys.launch` version. The handoff response includes the values as `templateId`, `version` and `templateHash` in `settlementTemplate`.

Migration 017 backfills every existing handoff to version 1. The escrow contract has only enforced these terms. The migration sets `app.service_name` for its transaction. Without that setting, forced row-level security hides all handoff rows from the non-superuser migrator. The test `settlement template backfill under forced row-level security` covers the backfill with that restriction.

## Recover after an image or migration failure

The handoff columns remain nullable. The gateway still refuses startup if the image manifest lacks applied migration `202611230017`.

Keep the migration ledger intact. Repair forward with a compatible release that includes the applied migration in its manifest.

## Recover when no version is active

If no version is active, the gateway refuses to create a settlement. It returns 503 `UPSTREAM_UNAVAILABLE` with `details.reason = 'no_active_settlement_template'`.

Only a direct database change can cause this state. The trigger refuses `retired → active` for every role. One operator other than the author can both review and activate the replacement.

To restore the terms, use a new version:

1. Check `retired_by`, `retired_at` and `request_id` to trace the change to `settlement_templates`.
2. Determine why the change occurred.
3. If the contract enforces the unchanged terms, deploy with `agroasys.launch:<version>` in the activation allowlist.
4. Through the store, create that version with the same terms.
5. As a reviewer other than the author, record the review.
6. After review, have an operator other than the author activate the replacement.
7. Verify the expected `settlementTemplate` on a new handoff.
