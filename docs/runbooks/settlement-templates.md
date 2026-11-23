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
| Only versions the contract enforces can become active                                  | The store's activation allowlist (default `agroasys.launch:1`)                                                      |
| The active version is not retired on its own                                           | The store: retiring it would leave no terms, so it is replaced only by activating another version                   |

The allowlist exists because the escrow still hard-codes `LaunchSettlementSchedule`. Activating different terms would describe settlements the contract does not run. Remove the allowlist when #955 makes the contract read template terms.

## Settlements record their template

The handoff insert takes `template_id`, `template_version` and `template_hash` from the active `agroasys.launch` version, in the same statement. The handoff response carries them as `settlementTemplate`.

Migration 017 backfills every existing handoff to v1, the only terms the contract has enforced. The migration sets `app.service_name` for its own transaction. Without that, forced row-level security would hide every row from a non-superuser migrator, and the backfill would do nothing. The test `settlement template backfill under forced row-level security` covers this case. The columns stay nullable, so the previous gateway image keeps working after a rollback.

## No active template

If no version is active, the gateway refuses to create settlements. It returns 503 `UPSTREAM_UNAVAILABLE` with `details.reason = 'no_active_settlement_template'`, and never creates a settlement without terms. Only a direct database change can cause this.

To recover:

1. Find out who changed `settlement_templates` and why. The row's `retired_by`, `retired_at` and `request_id` show this.
2. A retired version cannot be reactivated: the trigger refuses `retired → active` for every role. To restore the terms:
   1. Create the next version with the same terms.
   2. Have it reviewed and activated by two other people.
   3. Add `agroasys.launch:<version>` to the activation allowlist. This is safe only because the terms are unchanged, so the contract enforces them.
3. Confirm that a new handoff records the expected `settlementTemplate`.
