# Bridge Treasury Handoff Operations

## Scope

This runbook covers the treasury-side Bridge integration only. It does not change contract ownership, fee accrual, payout-receiver governance, or participant wallet semantics.

Bridge is an execution adapter here. `Cotsel` remains the treasury truth.

## Before handoff

Confirm all of these before creating a Bridge handoff:

- the treasury entry is in `READY_FOR_PARTNER_SUBMISSION`
- governance and payout-receiver approvals are already satisfied
- the sweep batch or treasury action is already canonical inside `Cotsel`

Do not use the Bridge handoff route to manufacture a treasury action that does not already exist internally.

## During handoff

Creating a Bridge handoff records:

- partner code
- handoff reference
- status
- transfer, drain, and payout references where available
- actor
- initiated timestamp

If the entry is still `READY_FOR_PARTNER_SUBMISSION`, the handoff route advances it to `AWAITING_PARTNER_UPDATE`.

## Evidence handling

Bridge evidence is appended through the treasury evidence path, not by mutating payout state directly.

Evidence may include:

- provider event ID
- event type
- transfer or payout reference
- drain reference
- destination external account reference
- liquidation address reference
- bank reference and bank state

If confirmed bank evidence is attached while the treasury entry is `AWAITING_PARTNER_UPDATE`, the treasury path auto-appends `PARTNER_REPORTED_COMPLETED`.

## Replay and conflict behavior

Use these rules:

- same handoff payload for the same ledger entry: idempotent replay
- same evidence payload for the same provider event: idempotent replay
- conflicting payload for the same handoff or evidence key: reject and investigate

Do not override conflicting Bridge evidence in place. That would corrupt treasury auditability.

## Investigation order

When treasury Bridge cash-out looks wrong, inspect:

1. treasury payout state history
2. treasury partner handoff record
3. treasury partner handoff evidence stream
4. bank confirmation record
5. export eligibility result

If Bridge says a transfer completed but bank confirmation is absent, treasury completion is still not earned.
