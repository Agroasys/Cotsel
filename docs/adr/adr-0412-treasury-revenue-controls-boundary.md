# ADR-0412: Treasury Revenue Controls Boundary and Truth Ownership

- Status: Accepted
- Date: 2026-04-15
- Related issue: TBD

## Context

Cotsel already has real on-chain fee accrual, treasury sweep primitives, governance controls, treasury evidence storage, and reconciliation hooks. What is missing is a stable operating model for revenue-close and treasury evidence.

Without an explicit control model, different services will drift into conflicting meanings for terms like `swept`, `handed off`, `realized`, and `closed`. That would create parallel truth between treasury business state, gateway approval state, reconciliation reports, and external execution evidence.

This ADR freezes the ownership model and state semantics before broader treasury-close workflow is added.

## Decision

**Cotsel is a settlement, treasury-controls, and revenue-evidence layer. It is not a bank, a fiat off-ramp, or a fee-policy engine.**

### Truth ownership

- **Contract truth**: settlement execution truth
  - trade lock and settlement execution
  - fee accrual into treasury claimable balance
  - treasury claim / sweep execution truth
- **Treasury truth**: ledger, batch, handoff, and realization linkage truth
  - fee accrual ledger entries
  - accounting periods
  - sweep batch composition
  - external handoff linkage
  - revenue realization records
- **Gateway truth**: approval and privileged action truth
  - who prepared, approved, signed, confirmed, or closed an action
  - ticket references, reasons, evidence links, and audit lineage
  - treasury capability enforcement for read, prepare, approve, execute-match, and close actions
- **Reconciliation truth**: tie-out and exception truth
  - whether persisted treasury, gateway, and chain records reconcile
  - whether close can proceed
  - why close is blocked when it cannot proceed
- **External execution truth**: fiat movement truth owned by the external regulated counterparty
  - handoff receipt, acknowledgment, completion, failure, or reversal of off-ramp/banking movement

### Boundary ownership

- Agroasys owns fee policy and commercial fee construction.
- Cotsel must not recompute buyer-side or supplier-side platform fee policy.
- Cotsel enforces settlement payloads, accrues treasury-entitled fees, and proves how those fees move.
- Cotsel stops at governed sweep plus evidence.
- External regulated counterparties execute fiat movement and remain the external source of truth for bank/off-ramp completion.

## Canonical state semantics

### Economic lifecycle

Every treasury execution-evidence entry represents fee value that is already economically earned once the underlying on-chain accrual event exists.

The accounting control state recorded around a treasury execution-evidence entry is separate from payout lifecycle state. Agroasys remains the accounting ledger of record for participant-visible balances and reporting.

### Treasury accounting states

- `HELD`
  - the fee has accrued and is held in the treasury path
  - the evidence is not yet allocated to a sweep batch
- `ALLOCATED_TO_SWEEP`
  - the execution-evidence entry has been assigned to a controlled sweep batch
  - no matched on-chain treasury claim has been recorded yet
- `SWEPT`
  - the execution-evidence entry belongs to a batch whose treasury claim transaction has been matched and confirmed
  - `SWEPT` does not mean only “someone clicked execute”
- `HANDED_OFF`
  - an external execution handoff record with a real counterparty reference exists for the swept amount
  - this does not imply counterparty completion or realized revenue
- `REALIZED`
  - the organization has accepted the amount as realized revenue under its operating rules
  - this must only happen through persisted, controlled evidence
- `EXCEPTION`
  - the ledger entry or its linked batch/handoff/realization path has a blocking failure, reversal, rejection, or invariant breach

### Accounting periods

- `OPEN`
  - new eligible accruals and new sweep allocations may be attached
- `PENDING_CLOSE`
  - close review is in progress
  - new allocations are blocked unless a controlled override path is explicitly implemented
- `CLOSED`
  - the period is immutable except through a future controlled reopening path with explicit audit reason

### Sweep batches

- `DRAFT`
  - business object is being prepared
- `PENDING_APPROVAL`
  - awaiting finance/treasury approval
- `APPROVED`
  - approved for governed execution
- `EXECUTED`
  - matched on-chain treasury claim execution has been recorded
- `HANDED_OFF`
  - external execution handoff reference is recorded against the executed batch
- `CLOSED`
  - all close preconditions are satisfied and the batch is complete
- `VOID`
  - batch is cancelled and cannot progress further

### External handoff statuses

Compatibility note:

- persisted schema and some API fields still use `partner_handoffs`, `partner_name`, and
  `partner_reference`
- these compatibility names do not change the underlying meaning
- the canonical semantics are external execution handoff evidence against a replaceable counterparty

- `CREATED`
  - handoff object exists
- `SUBMITTED`
  - the external execution handoff has actually been submitted
- `ACKNOWLEDGED`
  - counterparty acknowledgment evidence exists
- `COMPLETED`
  - counterparty completion evidence exists
- `FAILED`
  - counterparty reported failure or equivalent verified failure evidence exists

### Revenue realization statuses

- `REALIZED`
  - realized revenue decision recorded under controlled preconditions
- `REVERSED`
  - a previously realized amount was reversed under controlled correction procedure

## Control rules

- Treasury business state must be reproducible from persisted records only.
- No spreadsheet-only close semantics are allowed.
- No material state may rely on hidden manual mapping.
- Payout lifecycle state and accounting state must remain separate.
- Treasury operator mutations must enter through gateway-owned workflow surfaces; treasury internal mutation endpoints exist only for authenticated service-to-service calls.
- A sweep batch approver must be different from the batch creator and approval requester.
- A sweep batch executor must be different from the approver.
- A sweep batch closer must be different from the approver and executor.
- Treasury service must not directly trigger privileged chain execution.
- Gateway remains the privileged execution and approval boundary.
- Gateway treasury workflow should express distinct capability checks for read, prepare, approve,
  execute-match, and close actions even when the upstream auth service still falls back to an
  admin-wide treasury capability set.
- Reconciliation gates accounting-period close. Revenue realization still requires treasury evidence gates, but it is not separately reconciliation-gated in the current implementation.

## Forbidden truth duplication

The following must not happen:

- gateway becoming the source of truth for sweep batch composition
- reconciliation becoming the source of truth for batch or partner state
- treasury becoming the source of truth for who approved or signed a privileged action
- partner evidence being stored only in free-form notes without stable references or payload hashes

## Consequences

- New treasury schema and workflow must preserve raw facts and derive visible accounting state from projections.
- Close and realization are impossible to trust unless contract, treasury, gateway, and reconciliation references line up deterministically.
- Cotsel can productize revenue controls without becoming a banking or off-ramp operator.
