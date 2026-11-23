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

| Rule                                                                                   | Enforced by                                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A version moves `draft → reviewed → active → retired`, or `draft`/`reviewed → retired` | Store, and the `protect_settlement_template` trigger                                                                |
| Reviewer and activator are not the author                                              | Store, and the `settlement_templates_independent_*` constraints                                                     |
| At most one version per template is active                                             | The `settlement_templates_one_active` index; activation retires the previous active version in the same transaction |
| Terms, hash, author and recorded approvals never change, and no version is deleted     | The trigger; the runtime role has no `DELETE`                                                                       |
| A stored template must still match its hash when read                                  | The store recomputes the hash on every read                                                                         |
| Only versions the contract enforces can become active                                  | The activation allowlist, `GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST` (default `agroasys.launch:1`)                     |
| The active version is not retired on its own                                           | The store: retiring it would leave no terms, so it is replaced only by activating another version                   |

The allowlist exists because the escrow still hard-codes `LaunchSettlementSchedule`. Activating different terms would describe settlements the contract does not run. Remove the allowlist when #955 makes the contract read template terms.

## API

The gateway routes are under `/api/dashboard-gateway/v1/settlement-templates`. The full contract is in `docs/api/cotsel-dashboard-gateway.openapi.yml`.

- **Reads:** `GET /settlement-templates` (optional `templateId`) and `GET /settlement-templates/{templateId}/versions/{version}`. Both need `operator:read`.
- **Changes:** `POST /settlement-templates` with `{ "template": … }` to create a draft, then `POST …/versions/{version}/review`, `/activate` or `/retire`.
- **What a change needs:** write access, `governance:write`, an upstream step-up under five minutes old (403 `step_up_required` otherwise, from #946), and an `Idempotency-Key`.
- **Exact terms:** the template must have exactly the SDK's shape. Unknown keys are refused, because the hash would cover them.
- **Audit:** every change writes a `gateway.settlement_template.<action>` audit row, carrying the step-up evidence, in the same transaction as the change.

## Settlements record their template

The handoff insert takes `template_id`, `template_version` and `template_hash` from the active `agroasys.launch` version, in the same statement. The handoff response carries them as `settlementTemplate`.

Migration 017 backfills every existing handoff to v1, the only terms the contract has enforced. The migration sets `app.service_name` for its own transaction. Without that, forced row-level security would hide every row from a non-superuser migrator, and the backfill would do nothing. The test `settlement template backfill under forced row-level security` covers this case. The columns stay nullable, so the previous gateway image keeps working after a rollback.

## No active template

If no version is active, the gateway refuses to create settlements. It returns 503 `UPSTREAM_UNAVAILABLE` with `details.reason = 'no_active_settlement_template'`, and never creates a settlement without terms. Only a direct database change can cause this.

To recover:

1. Find out who changed `settlement_templates` and why. The row's `retired_by`, `retired_at` and `request_id` show this.
2. A retired version cannot be reactivated: the trigger refuses `retired → active` for every role. Restore the terms as a new version, in this order, because activation refuses any version not yet allowlisted:
   1. Deploy the next version, `agroasys.launch:<version>`, in `GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST`. This is safe only because its terms are unchanged, so the contract enforces them.
   2. Create that version with the same terms.
   3. Have it reviewed, then activated, by someone other than its author. The rule is two people: the author, plus one other who may both review and activate.
3. Confirm that a new handoff records the expected `settlementTemplate`.
