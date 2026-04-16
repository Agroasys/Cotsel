# Bridge Treasury Adapter Boundary

Bridge treasury support in `Cotsel` is an execution adapter for governed sweep-batch handoff and
cash-out only.

The contracts remain unchanged. `AgroasysEscrow.sol` continues to own settlement, fee accrual, and payout-receiver governance. Treasury sweep authorization, payout-receiver changes, and export eligibility continue to follow the existing governance and treasury controls.

The Bridge integration point in this repo is the treasury external-handoff and evidence layer. A
governed sweep batch can be handed off to Bridge through the treasury API, which records a durable
external handoff reference plus the supporting deposit and bank-confirmation evidence needed for
treasury completion. Those records are audit support for external execution. They are not a second
ledger and they do not replace the existing payout lifecycle or bank-confirmation rules.

Completion truth still follows the existing treasury boundary: confirmed bank payout evidence is
required before an entry reaches `EXTERNAL_EXECUTION_CONFIRMED`, and export remains blocked until
that evidence exists. Bridge handoff records add partner execution traceability without moving
treasury authority out of `Cotsel`.

Operationally, this means:

- Bridge handoff creation is a durable treasury record, not an in-memory dispatch
- duplicate handoff or evidence payloads are treated as idempotent replay only when the payload matches exactly
- conflicting handoff or evidence payloads are rejected instead of silently mutating treasury truth
- confirmed bank evidence still gates treasury completion and export eligibility
