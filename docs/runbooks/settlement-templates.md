# Settlement templates

Audience: gateway engineers and the operators who approve settlement terms. Scope: #940, the gateway template registry (migration `202611230017`) and the SDK template module (`@agroasys/sdk`, `settlementTemplate`).

## What a template is

A settlement template is the canonical description of a settlement's terms:

- the asset and its quantum;
- the milestone release shares, and which milestone carries the supplier fee;
- the buyer and supplier fees, the fixed support fee and the rounding rule;
- the lock, transit, inspection and dispute windows.

Its identity is `templateId` plus `version`. Its `templateHash` is the SHA-256 of its canonical JSON, from `settlementTemplateHash`.

Template `agroasys.launch` v1 records exactly the terms the deployed escrow enforces: `LaunchSettlementSchedule` and the `AgroasysEscrow` window constants. Slice 1 (#963) proved that against the contract in Hardhat. Migration 017 seeds v1 as active, with author, reviewer and activator `migration:017`.

## Rules

| Rule                                                                                                                                   | Enforced by                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A version moves `draft → reviewed → active → retired`, or `draft`/`reviewed → retired`                                                 | Store, and the `protect_settlement_template` trigger                                                                                            |
| Reviewer and activator are not the author                                                                                              | Store, and the `settlement_templates_independent_*` constraints                                                                                 |
| At most one version per template is active                                                                                             | The `settlement_templates_one_active` index                                                                                                     |
| Terms, hash, author and recorded approvals never change, and no version is deleted                                                     | The trigger; the runtime role has no `DELETE`                                                                                                   |
| A stored template must still match its hash when read                                                                                  | The store recomputes the hash on every read                                                                                                     |
| Only versions the contract enforces can become active                                                                                  | The activation allowlist, `GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST` (default `agroasys.launch:1`)                                                 |
| A version becomes active only through a confirmed activation preparation, and only replacing the predecessor that preparation expected | `settlement_template_activations` and the `settlement_templates_governed_activation` trigger (migration 018): even a direct `UPDATE` is refused |
| The activation approver is neither its preparer nor the template author; the confirmer is not the template author                      | Store, and the `template_activations_independent_approval` constraint                                                                           |
| The active version is not retired on its own                                                                                           | The store, and the `settlement_templates_governed_activation` trigger (migration 018)                                                           |

The allowlist exists because the escrow still hard-codes `LaunchSettlementSchedule`. Activating different terms would describe settlements the contract does not run. Remove the allowlist when #955 makes the contract read template terms.

## API

The gateway routes are under `/api/dashboard-gateway/v1/settlement-templates`. The full contract is in `docs/api/cotsel-dashboard-gateway.openapi.yml`.

- **Reads:** `GET /settlement-templates` (optional `templateId`) and `GET /settlement-templates/{templateId}/versions/{version}`. Both need `operator:read`.
- **Changes:** `POST /settlement-templates` with `{ "template": … }` creates a draft. `POST …/versions/{version}/review` and `/retire` change a version.
- **Activation (governed, review R05).** There is no direct activate route. A version becomes active in three steps:
  1. `POST …/versions/{version}/activations` prepares it. The preparation records the exact target (id, version, terms hash) and the exact active version it will replace, or none. It is valid for 24 hours.
  2. `POST /settlement-templates/activations/{preparationId}/approve` records the approval. The approver must be neither the preparer nor the template author.
  3. `POST /settlement-templates/activations/{preparationId}/confirm` activates it. Under lock, it re-checks that the target is unchanged and still `reviewed`, and that the active version is still the expected one. Then, in one transaction, it retires the predecessor, activates the target and writes the audit row. The confirmer may be the approver, but not the template author.

  If the target or predecessor changed, the preparation is marked `superseded` and refused (409 `activation_preparation_stale`); prepare again. `GET /settlement-templates/activations` lists every preparation with its approver and outcome.

- **What a change needs:** write access, `governance:write`, an upstream step-up under five minutes old (403 `step_up_required` otherwise, from #946), and an `Idempotency-Key`.
- **Exact terms:** the template must have exactly the SDK's shape. Unknown keys are refused, because the hash would cover them.
- **Audit:** every change writes a `gateway.settlement_template.<action>` audit row, carrying the step-up evidence, in the same transaction as the change. The actions are `created`, `reviewed`, `retired`, `activation_prepared`, `activation_approved`, `activation_superseded` and `activated`. An `activated` row records the preparation, its preparer and approver, and the expected and actually retired versions.

## Settlements record their template

The handoff insert takes `template_id`, `template_version` and `template_hash` from the active `agroasys.launch` version, in the same statement. The handoff response carries them as `settlementTemplate`.

Migration 017 backfills every existing handoff to v1, the only terms the contract has enforced. The migration sets `app.service_name` for its own transaction. Without that, forced row-level security would hide every row from a non-superuser migrator, and the backfill would do nothing. The test `settlement template backfill under forced row-level security` covers this case. **Rollback:** an earlier gateway image does not start against this database. Its migration check refuses applied migrations missing from its manifest (`202611230017`, `202611240018`), and the migration ledger must not be edited to get around that. The supported recovery is forward: a compatibility release that keeps these migrations in its manifest. The rollback procedure, with an image digest and a rehearsal, is tracked as review item D1 and is not yet available.

## No active template

If no version is active, the gateway refuses to create settlements. It returns 503 `UPSTREAM_UNAVAILABLE` with `details.reason = 'no_active_settlement_template'`, and never creates a settlement without terms. Only a database intervention that disables triggers can cause this: since migration 018, even a direct `UPDATE` cannot retire the active version without a confirmed replacement.

To recover:

1. Find out who changed `settlement_templates` and why. The row's `retired_by`, `retired_at` and `request_id` show this.
2. A retired version cannot be reactivated: the trigger refuses `retired → active` for every role. Restore the terms as a new version, in this order, because activation refuses any version not yet allowlisted:
   1. Deploy the next version, `agroasys.launch:<version>`, in `GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST`. This is safe only because its terms are unchanged, so the contract enforces them.
   2. Create that version with the same terms.
   3. Have it reviewed by someone other than its author, then prepare, approve and confirm its activation. The approver is neither the preparer nor the author. Because the predecessor is gone, the preparation expects no active version.
3. Confirm that a new handoff records the expected `settlementTemplate`.
