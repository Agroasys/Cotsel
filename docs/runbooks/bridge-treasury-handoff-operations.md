# Bridge Treasury Handoff Operations

## Scope

This runbook covers the treasury-side Bridge integration only. It does not change contract ownership, fee accrual, payout-receiver governance, or participant wallet semantics.

Bridge is an execution adapter here. `Cotsel` remains the treasury truth.

## Before handoff

Confirm all of these before creating a Bridge handoff:

- the treasury entry is already allocated into a governed sweep batch
- the sweep batch is in `EXECUTED` state and ready for external handoff
- governance and payout-receiver approvals are already satisfied
- the sweep batch or treasury action is already canonical inside `Cotsel`

Do not use the Bridge handoff route to manufacture a treasury action that does not already exist internally.

## During handoff

Creating a Bridge handoff records:

- partner name
- handoff reference
- handoff status
- evidence reference where available
- batch-linked metadata

Use the canonical treasury route:

- `POST /api/treasury/v1/internal/sweep-batches/:batchId/external-handoff`
- legacy alias: `POST /api/treasury/v1/internal/sweep-batches/:batchId/partner-handoff`

For ledger-entry Bridge execution traceability, treasury also exposes:

- `POST /api/treasury/v1/internal/entries/:entryId/partner-handoff`
- `GET /api/treasury/v1/entries/:entryId/partner-handoff`
- `POST /api/treasury/v1/internal/entries/:entryId/partner-handoff/evidence`

## Evidence handling

Bridge execution evidence is recorded through the canonical external handoff record plus bank
confirmation and deposit evidence, not by mutating payout state directly.

Evidence may include:

- handoff status updates from the external counterparty
- partner reference
- provider event ids
- evidence reference
- bank reference and bank state
- deposit/provider references recorded through treasury deposit evidence

If confirmed bank evidence is attached while the treasury entry is `AWAITING_EXTERNAL_CONFIRMATION`,
the treasury path auto-appends `EXTERNAL_EXECUTION_CONFIRMED`.

## Replay and conflict behavior

Use these rules:

- same external handoff payload for the same sweep batch: idempotent replay
- same evidence payload for the same provider or bank event key: idempotent replay
- conflicting payload for the same handoff or evidence key: reject and investigate

Do not override conflicting Bridge evidence in place. That would corrupt treasury auditability.

## Investigation order

When treasury Bridge cash-out looks wrong, inspect:

1. treasury payout state history
2. sweep batch external handoff record
3. deposit and bank confirmation evidence
4. bank confirmation record
5. export eligibility result

If Bridge says a transfer completed but bank confirmation is absent, treasury completion is still not earned.
