# Treasury Revenue Close Runbook

## Purpose

Operate treasury fee close as a controlled revenue-evidence workflow.

This runbook is the operator procedure for the off-chain control layer between:

- on-chain fee accrual and treasury claim events
- external execution handoff evidence
- controlled revenue realization

Architecture boundary, truth ownership, and canonical state semantics are defined once in:

- `docs/adr/adr-0412-treasury-revenue-controls-boundary.md`

## Preconditions

- Treasury service healthy:

```bash
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/health"
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/ready"
```

- Gateway treasury read/write surfaces reachable for operators.
- Reconciliation latest run is fresh and drift-free for the trade set being closed.
- Treasury payout receiver is already governed and valid.
- Separation of duties is enforced:
  - preparer must not be approver
  - approver must not be executor
  - approver or executor must not be closer

## Procedure

### 1. Open or confirm the accounting period

Create the period through gateway if it does not exist:

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/accounting-periods" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "periodKey":"2026-Q2",
    "startsAt":"2026-04-01T00:00:00.000Z",
    "endsAt":"2026-06-30T23:59:59.000Z",
    "audit":{"reason":"Open treasury close period","ticketRef":"FIN-200"}
  }'
```

Review existing periods:

```bash
curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/accounting-periods?status=OPEN&limit=50&offset=0" \
  -H "Authorization: Bearer $SESSION_TOKEN"
```

### 2. Review held or sweep-linked entry accounting state

List fee entries by accounting posture:

```bash
curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/entries/accounting?accountingState=HELD&limit=100&offset=0" \
  -H "Authorization: Bearer $SESSION_TOKEN"
```

Operator checks:

- trade id and component type are expected
- amount matches treasury-earned fee evidence
- entry is not already allocated to another active batch
- no unresolved exception state is present

### 3. Create and populate the sweep batch

Create draft batch:

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/sweep-batches" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "batchKey":"2026-q2-fees-001",
    "accountingPeriodId":7,
    "assetSymbol":"USDC",
    "expectedTotalRaw":"125000000",
    "audit":{"reason":"Prepare treasury fee sweep batch","ticketRef":"FIN-201"}
  }'
```

Allocate entries:

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/sweep-batches/11/entries" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ledgerEntryId":501,
    "audit":{"reason":"Allocate fee entry into approved sweep batch","ticketRef":"FIN-201"}
  }'
```

### 4. Request approval and approve

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/sweep-batches/11/request-approval" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"audit":{"reason":"Request independent approval for treasury sweep","ticketRef":"FIN-202"}}'
```

Independent approver:

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/sweep-batches/11/approve" \
  -H "Authorization: Bearer $APPROVER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"audit":{"reason":"Approve treasury sweep batch after review","ticketRef":"FIN-202"}}'
```

Do not approve if:

- allocated total differs from expected total
- payout receiver is not the governed active receiver
- reconciliation for included trades is stale, missing, or blocked

### 5. Match the on-chain treasury claim

After governed treasury claim execution is complete, match the approved batch to indexed
`TreasuryClaimed` evidence:

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/sweep-batches/11/match-execution" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "matchedSweepTxHash":"0xsweep-1",
    "audit":{"reason":"Match on-chain treasury claim to approved sweep batch","ticketRef":"FIN-203"}
  }'
```

This step does not trust operator-supplied amount or destination fields. Treasury matches the
transaction hash to indexed claim evidence and rejects the batch if the observed claim amount or
destination does not match the approved batch.

`SWEPT` means the claim transaction has been matched to indexed on-chain evidence, not merely
initiated.

### 6. Record external execution handoff evidence

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/sweep-batches/11/external-handoff" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "partnerName":"licensed-partner",
    "partnerReference":"partner-ref-1",
    "handoffStatus":"ACKNOWLEDGED",
    "evidenceReference":"evidence://partner-ref-1",
    "audit":{"reason":"Record external execution handoff reference","ticketRef":"FIN-204"}
  }'
```

External execution handoff is evidence-only inside Cotsel. Off-ramp execution remains
counterparty-owned.

Compatibility note:

- request fields remain `partnerName` and `partnerReference` for stable client compatibility
- the legacy route `/treasury/sweep-batches/:batchId/partner-handoff` remains supported as an alias
  to `/treasury/sweep-batches/:batchId/external-handoff`

### 7. Record realization only after evidence is complete

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/entries/501/realizations" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountingPeriodId":7,
    "sweepBatchId":11,
    "partnerHandoffId":33,
    "note":"Revenue realized after partner and bank confirmation",
    "audit":{"reason":"Record controlled revenue realization","ticketRef":"FIN-205"}
  }'
```

Realization preconditions:

- batch must already be `HANDED_OFF` or `CLOSED`
- external handoff must be completed
- bank confirmation evidence must be confirmed
- supplied accounting period, batch, and handoff references must match the entry linkage

### 8. Close the batch and the period

Close batch only after all linked entries are `REALIZED`:

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/sweep-batches/11/close" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"audit":{"reason":"Close treasury sweep batch after realization review","ticketRef":"FIN-206"}}'
```

Request close, then close the period:

```bash
curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/accounting-periods/7/request-close" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"audit":{"reason":"Request accounting period close","ticketRef":"FIN-207"}}'

curl -fsS -X POST "http://127.0.0.1:${GATEWAY_PORT:-3001}/api/dashboard-gateway/v1/treasury/accounting-periods/7/close" \
  -H "Authorization: Bearer $CLOSER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"audit":{"reason":"Close accounting period after reconciliation review","ticketRef":"FIN-208"}}'
```

Period close is blocked when:

- sweep batches in the period remain open
- reconciliation is not clear for the trades covered by closed batches

## Required Evidence Packet

For every batch/period close, attach:

- gateway audit trail
- sweep batch detail export
- reconciliation report rows for included trades
- on-chain treasury claim reference
- external execution handoff reference
- bank confirmation evidence
- approval ticket and reviewer identities

Related template:

- `docs/runbooks/operator-audit-evidence-template.md`

## Do Not Do

- Do not compute fee policy inside Cotsel.
- Do not treat external handoff as bank finality.
- Do not mark entries realized before evidence preconditions pass.
- Do not close a period from spreadsheet state that cannot be reproduced from service data.
- Do not let the preparer approve the same batch.
- Do not let the approver execute the same batch.
- Do not let the approver or executor close the same batch.
