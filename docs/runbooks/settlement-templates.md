# Settlement templates

Use this runbook to review, activate or recover settlement templates. It is for gateway engineers and operators who approve settlement terms.

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

| Rule                                                                                                                                                  | Control                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A version moves from `draft` to `reviewed`, then to `active`, then to `retired`. A `draft` or `reviewed` version can also move directly to `retired`. | The store and the `protect_settlement_template` trigger enforce these transitions.                                                                                         |
| The reviewer and activator must each be someone other than the author.                                                                                | The store and the `settlement_templates_independent_*` constraints enforce this rule.                                                                                      |
| Each template has at most one active version.                                                                                                         | The `settlement_templates_one_active` index enforces this limit.                                                                                                           |
| The terms, hash, author and recorded approvals are immutable. All versions must remain in the registry.                                               | The trigger protects these records. The runtime role has no `DELETE` permission.                                                                                           |
| A stored template must match its hash.                                                                                                                | The store recomputes the hash on every read.                                                                                                                               |
| Only versions with contract-enforced terms can become active.                                                                                         | `GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST` limits activation. The default is `agroasys.launch:1`.                                                                             |
| Only a confirmed activation preparation can activate a version. It must replace the exact predecessor in the preparation, if one exists.              | `settlement_template_activations` and the `settlement_templates_governed_activation` trigger enforce the rule. Migration 018 prevents a direct `UPDATE` from bypassing it. |
| The activation approver must be independent of the preparer and the author. The author cannot confirm the activation.                                 | The store and the `template_activations_independent_approval` constraint enforce separate roles.                                                                           |
| The active version can retire only during its replacement.                                                                                            | The store and the `settlement_templates_governed_activation` trigger enforce this rule.                                                                                    |

The escrow contract uses a fixed `LaunchSettlementSchedule`. When #955 makes the contract read template terms, remove the allowlist.

## Gateway routes

The settlement template application programming interface (API) is under `/api/dashboard-gateway/v1/settlement-templates`. The routes below are relative to `/api/dashboard-gateway/v1`. The [gateway API contract](../api/cotsel-dashboard-gateway.openapi.yml) defines the requests and responses.

### Read or change a version

The registry provides these routes:

- `GET /settlement-templates` lists templates and accepts an optional `templateId` filter.
- `GET /settlement-templates/{templateId}/versions/{version}` reads one version.
- `POST /settlement-templates` creates a draft from `{ "template": … }`.
- `POST /settlement-templates/{templateId}/versions/{version}/review` records a review.
- `POST /settlement-templates/{templateId}/versions/{version}/retire` retires a version.
- `GET /settlement-templates/activations` lists every activation preparation with its approver and outcome.

Template reads require `operator:read`. Every change requires write access, `governance:write` and an `Idempotency-Key`. Changes require fresh upstream step-up authentication (#946). The default age limit is five minutes. If assurance fails the step-up policy in enforce mode, the gateway returns 403 `step_up_required`.

A template must use the exact SDK structure. The gateway rejects unknown keys because those keys would affect the hash.

### Activate a reviewed version

Use the governed activation procedure (review item R05). The gateway has no direct activation route.

Before preparation, the target version must be `reviewed` and on the activation allowlist. The preparation records the exact target identifier, version and terms hash. It records the exact predecessor or the absence of an active version. The preparation expires after 24 hours.

1. Send `POST /settlement-templates/{templateId}/versions/{version}/activations` to prepare the activation.
2. As an operator independent of the preparer and author, send `POST /settlement-templates/activations/{preparationId}/approve`.
3. If you did not author the template, send `POST /settlement-templates/activations/{preparationId}/confirm`.

The approver can also confirm. While the gateway holds the lock, it verifies that the target is still `reviewed` and that its terms match the approved hash. It compares the active version with the expected predecessor. The gateway also checks the current allowlist.

In one transaction, the gateway confirms the preparation, retires the predecessor if present, activates the target and writes the audit row.

If the target or predecessor changed, the gateway records `superseded` before it returns 409 `activation_preparation_stale`. If the gateway marks the preparation `superseded`, prepare a new activation.

### Audit records

Each change writes a `gateway.settlement_template.<action>` audit row with the step-up evidence in the same transaction. The audit actions are:

- `created`
- `reviewed`
- `retired`
- `activation_prepared`
- `activation_approved`
- `activation_superseded`
- `activated`

An `activated` row records the preparation, its preparer and its approver. It also records the expected predecessor and the version that the transaction retired.

## Template on each handoff

In the same statement, the handoff insert reads `template_id`, `template_version` and `template_hash` from the active `agroasys.launch` version. The handoff response includes the values as `templateId`, `version` and `templateHash` in `settlementTemplate`.

Migration 017 backfills every existing handoff to version 1. The escrow contract has only enforced these terms. The migration sets `app.service_name` for its transaction. Without that setting, forced row-level security hides all handoff rows from the non-superuser migrator. The test `settlement template backfill under forced row-level security` covers the backfill with that restriction.

## Recover after an image or migration failure

An earlier gateway image cannot start if its manifest lacks an applied migration. The migration check includes `202611230017` and `202611240018`.

Keep the migration ledger intact. Repair forward with a compatible release that includes the applied migrations in its manifest. A reviewed procedure with an exact image digest and a deployment rehearsal remains open under review item D1.

## Recover when no version is active

If no version is active, the gateway refuses to create a settlement. It returns 503 `UPSTREAM_UNAVAILABLE` with `details.reason = 'no_active_settlement_template'`.

Migration 018 requires a confirmed replacement to retire the active version, even for a direct `UPDATE`. Losing the active version requires database intervention that bypasses the trigger controls. The trigger refuses `retired → active` for every role.

To restore the terms, use a new version:

1. Check `retired_by`, `retired_at` and `request_id` to trace the change to `settlement_templates`.
2. Determine why the change occurred.
3. If the contract enforces the unchanged terms, deploy the gateway with `agroasys.launch:<version>` in `GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST`.
4. Create that version with the same terms.
5. As a reviewer other than the author, record the review.
6. After review, prepare the activation with no active predecessor.
7. As an approver independent of the preparer and author, approve the preparation.
8. As an operator other than the author, confirm the approved preparation.
9. Verify the expected `settlementTemplate` on a new handoff.
