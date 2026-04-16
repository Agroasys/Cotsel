# Treasury-to-Fiat External Handoff SOP

## Purpose

Define the controlled operational procedure for moving already-swept treasury value from
Cotsel-held treasury evidence into an external regulated execution path without collapsing the
treasury boundary.

This SOP is intentionally narrow:

- it starts after treasury value has already been swept through governed Cotsel controls
- it covers only external execution handoff evidence, deposit evidence, bank confirmation evidence,
  and exception handling
- it does not make Cotsel a bank, off-ramp executor, or provider workflow engine

Canonical control model:

- `docs/adr/adr-0412-treasury-revenue-controls-boundary.md`
- `docs/runbooks/treasury-revenue-close.md`

Primary operators:

- `Treasury Operator`
- `Treasury Approver`
- `Compliance Reviewer`
- `On-call Engineer`

## Preconditions

- Treasury service is healthy:

```bash
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/health"
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/ready"
```

- Treasury-entitled amounts have already been swept on-chain through governed treasury controls.
- Any batch-level prepare/approve/execute flow has already happened through gateway.
- Treasury entries exist from indexed stage-1 events (`FundsReleasedStage1`, `PlatformFeesPaidStage1`).
- Service-auth headers are available when `TREASURY_AUTH_ENABLED=true`.

If `TREASURY_AUTH_ENABLED=true`, include required HMAC headers on internal treasury calls:

- `x-agroasys-timestamp`
- `x-agroasys-signature`
- `x-agroasys-nonce` (optional)
- `X-Api-Key` (when key-based auth is used)

## Safety Guardrails

- Never execute payout without an approved ledger entry and evidence package.
- Never treat this SOP as a substitute for gateway-owned treasury sweep approval.
- Never use treasury evidence routes as a public admin mutation surface.
- Never skip payout state transitions or force `EXTERNAL_EXECUTION_CONFIRMED` directly.
- Never represent Cotsel or Agroasys as the direct bank or off-ramp executor.
- Never represent Cotsel or Agroasys as the party that owns bank payout finality; the licensed payout partner owns rail execution and completion truth.
- Never route treasury execution through participant wallet infrastructure.
- Never route treasury execution through buyer-facing AA, paymaster, or sponsored-gas shortcuts; treasury operators must use the explicit privileged signer path only.
- Never improvise a new payout destination; treasury sweep destination remains contract-controlled.
- When Bridge is the execution partner, never bypass the treasury handoff and evidence routes. Use the controlled flow documented in [`bridge-treasury-handoff-operations.md`](./bridge-treasury-handoff-operations.md).

## Treasury Payout Lifecycle

Treasury payout lifecycle source of truth:

- `treasury/src/types.ts`
- `treasury/src/core/payout.ts`
- `treasury/src/api/controller.ts`

Lifecycle:

- `PENDING_REVIEW`
- `READY_FOR_EXTERNAL_HANDOFF`
- `AWAITING_EXTERNAL_CONFIRMATION`
- `EXTERNAL_EXECUTION_CONFIRMED`
- `CANCELLED`

These states are operational evidence states for payout follow-through. They do not replace:

- sweep-batch accounting state
- revenue realization state
- reconciliation close truth

## Fiat Ramp Deposit Evidence Contract

Treasury source of truth:

- `treasury/src/types.ts`
- `treasury/src/database/schema.sql`
- `treasury/src/database/queries.ts`
- `POST /api/treasury/v1/internal/deposits`

Each funding or settlement-related external money observation must be recorded with:

- `rampReference`: stable external funding-path reference
- `tradeId`: business anchor
- `ledgerEntryId`: optional but preferred treasury entry anchor
- `depositState`: `PENDING`, `FUNDED`, `PARTIAL`, `REVERSED`, or `FAILED`
- `sourceAmount`: observed amount as an integer string
- `currency`: observed currency code
- `expectedAmount`: approved expected amount as an integer string
- `expectedCurrency`: approved expected currency code
- `observedAt`: provider observation timestamp
- `providerEventId`: idempotency key for the external event
- `providerAccountRef`: external account or rail reference
- `failureCode`: optional external failure code
- `reversalReference`: optional reversal or clawback reference
- `metadata`: optional structured evidence fields

Deterministic failure classes:

- `MISSING_TRADE_MAPPING`
- `DUPLICATE_PROVIDER_EVENT`
- `PARTIAL_FUNDING`
- `REVERSED_FUNDING`
- `STALE_PENDING_DEPOSIT`
- `AMOUNT_MISMATCH`
- `CURRENCY_MISMATCH`

## Bank Settlement Confirmation Contract

Treasury source of truth:

- `treasury/src/core/bankPayout.ts`
- `treasury/src/database/schema.sql`
- `treasury/src/database/queries.ts`
- `POST /api/treasury/v1/internal/entries/:entryId/bank-confirmation`

Each bank settlement record must include:

- `bankReference`: stable bank-side settlement identifier
- `bankState`: `PENDING`, `CONFIRMED`, or `REJECTED`
- `confirmedAt`: observation timestamp
- `source`: integration source such as `bank:webhook` or `operator:manual`
- `actor`: operator or system actor recording the evidence
- `payoutReference`: optional treasury or external reference
- `failureCode`: optional bank failure code
- `evidenceReference`: optional receipt, statement row, or case identifier
- `metadata`: optional structured evidence fields

Guardrails:

- bank settlement evidence is not valid while treasury payout state is `PENDING_REVIEW` or
  `READY_FOR_EXTERNAL_HANDOFF`
- `PENDING` bank state is only valid while treasury payout state is
  `AWAITING_EXTERNAL_CONFIRMATION`
- bank settlement evidence is not valid after treasury payout entry is `CANCELLED`
- replaying the same `bankReference` with the same payload is idempotent
- replaying the same `bankReference` with a different payload is rejected as a conflict

## Procedure

### 1. Confirm treasury sweep and entry eligibility

Before beginning any external execution handoff, confirm:

- governed treasury sweep has already completed on-chain
- the relevant `TreasuryClaimed` evidence is matched in treasury
- the entry is approved for payout evidence progression

Check entries:

```bash
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/entries?state=PENDING_REVIEW&limit=100&offset=0"
```

If entries are missing, ingest indexed evidence:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/internal/ingest"
```

### 2. Move entry to `READY_FOR_EXTERNAL_HANDOFF`

This is an internal evidence progression step after the entry has been approved for follow-through:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/internal/entries/<entry-id>/state" \
  -H "Content-Type: application/json" \
  -d '{"state":"READY_FOR_EXTERNAL_HANDOFF","note":"Approved for external execution handoff","actor":"Treasury Approver"}'
```

Do not continue if:

- destination details are ambiguous
- approval lineage is incomplete
- the entry still has unresolved exception evidence

### 3. Start the external execution window

Validate current state and transition legality against the payout state machine in `treasury/src/core/payout.ts` before sending anything to the external execution partner.

Record the Bridge execution handoff itself through the treasury handoff route:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/internal/entries/<entry-id>/partner-handoff" \
  -H "Content-Type: application/json" \
  -d '{
    "partnerCode":"bridge",
    "handoffReference":"bridge-handoff-2026-03-26-001",
    "partnerStatus":"SUBMITTED",
    "transferReference":"bridge-transfer-2026-03-26-001",
    "destinationExternalAccountId":"bridge-external-account-001",
    "sourceAmount":"1000000",
    "sourceCurrency":"USDC",
    "destinationAmount":"1000000",
    "destinationCurrency":"USD",
    "actor":"Treasury Operator",
    "note":"Bridge execution handoff recorded from Cotsel treasury",
    "initiatedAt":"2026-03-26T00:00:00.000Z",
    "metadata":{"submittedBy":"Treasury Operator"}
  }'
```

Once the request has been handed to the external regulated counterparty, move the entry into
waiting state:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/internal/entries/<entry-id>/state" \
  -H "Content-Type: application/json" \
  -d '{"state":"AWAITING_EXTERNAL_CONFIRMATION","note":"Submitted to external execution counterparty; awaiting confirmation","actor":"Treasury Operator"}'
```

Record the initial external funding or execution reference:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/internal/deposits" \
  -H "Content-Type: application/json" \
  -d '{
    "rampReference":"ramp-2026-03-26-001",
    "tradeId":"<trade-id>",
    "ledgerEntryId":<entry-id>,
    "depositState":"PENDING",
    "sourceAmount":"1000000",
    "currency":"USD",
    "expectedAmount":"1000000",
    "expectedCurrency":"USD",
    "observedAt":"2026-03-26T00:00:00.000Z",
    "providerEventId":"provider-event-001",
    "providerAccountRef":"acct-usd-1"
  }'
```

Expected result:

- the handoff window is recorded in treasury evidence
- the external counterparty reference is persisted for later reconciliation

### 4. Record external completion evidence

When external execution reaches a bank-observed confirmation point, record bank settlement evidence:

```bash
curl -fsS -X POST "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/internal/entries/<entry-id>/bank-confirmation" \
  -H "Content-Type: application/json" \
  -d '{
    "payoutReference":"payout-2026-03-26-001",
    "bankReference":"bank-2026-03-26-001",
    "bankState":"CONFIRMED",
    "confirmedAt":"2026-03-26T04:30:00.000Z",
    "source":"bank:webhook",
    "actor":"Treasury Operator",
    "evidenceReference":"receipt-2026-03-26-001"
  }'
```

When bank confirmation is accepted, treasury can auto-progress the payout lifecycle to
`EXTERNAL_EXECUTION_CONFIRMED`.

Record any matching deposit/funding update for the same `rampReference` as `FUNDED`,
`PARTIAL`, `REVERSED`, or `FAILED` as observed.

Expected result:

- entry ends in `EXTERNAL_EXECUTION_CONFIRMED` only when confirmation evidence is present
- external evidence is linked to the same treasury entry and trade context

### 5. Hand off to reconciliation and revenue close

After payout evidence is complete:

- reconciliation consumes the same treasury evidence and sweep linkage
- revenue realization remains a separate controlled step
- batch and period close remain governed by the treasury revenue-close workflow

This SOP does not itself realize revenue or close accounting periods.

## Exception Handling

### Wrong destination or incorrect submission

- stop immediately
- do not advance the entry to `AWAITING_EXTERNAL_CONFIRMATION` if the handoff is not valid
- mark entry `CANCELLED` with explicit reason when safe cancellation is the correct action
- escalate to compliance reviewer and on-call engineer

### External execution failure

- keep state at `AWAITING_EXTERNAL_CONFIRMATION` only while an active retry or investigation plan
  exists
- persist failure through deposit evidence with `depositState="FAILED"` and `failureCode`
- if the path cannot recover safely, set `CANCELLED` and open an incident

### Partial settlement

- do not treat the entry as externally confirmed until the full amount is reconciled
- persist the external event with `depositState="PARTIAL"`
- escalate discrepancy handling through reconciliation

### Reversal or bank rejection

- persist `depositState="REVERSED"` or `bankState="REJECTED"` before deciding whether the entry
  remains in investigation or is cancelled
- do not mark or keep the entry as externally confirmed after a reversal or rejected settlement

## Evidence Minimum

- actor for every lifecycle transition and evidence write
- destination validation result
- amount/currency checks and approval artifacts
- external reference, settlement timestamp, and linked trade/entry context
- `trade_id`, `entry_id`, `tx_hash`, and incident/ticket IDs

Templates:

- `docs/runbooks/operator-audit-evidence-template.md`
- `docs/incidents/incident-evidence-template.md`

## Related References

- `treasury/README.md`
- `docs/runbooks/reconciliation.md`
- `docs/runbooks/treasury-revenue-close.md`
- `docs/runbooks/programmability-governance.md`
