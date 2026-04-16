# Bridge Treasury Adapter Boundary

Bridge treasury support in `Cotsel` is an execution adapter for treasury sweeps and cash-out only.

The contracts remain unchanged. `AgroasysEscrow.sol` continues to own settlement, fee accrual, and payout-receiver governance. Treasury sweep authorization, payout-receiver changes, and export eligibility continue to follow the existing governance and treasury controls.

The Bridge integration point in this repo is the treasury handoff and evidence layer. A treasury payout entry can be handed off to Bridge through the treasury API, which records a durable handoff reference and a stream of Bridge evidence events. Those records are audit support for external execution. They are not a second ledger and they do not replace the existing payout lifecycle or bank-confirmation rules.

Completion truth still follows the existing treasury boundary: confirmed bank payout evidence is required before an entry reaches `PARTNER_REPORTED_COMPLETED`, and export remains blocked until that evidence exists. Bridge handoff records and Bridge evidence events add partner execution traceability without moving treasury authority out of `Cotsel`.
