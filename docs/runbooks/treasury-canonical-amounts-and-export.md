# Treasury Canonical Amounts and Complete Export

Canonical monetary typing, sweep allocation invariants, and the bounded,
reconcilable treasury ledger export.

- **Owner:** Treasury and Finance owners
- **Traceability:** WP-4, findings H-24 and H-32 ([Agroasys/Cotsel#658](https://github.com/Agroasys/Cotsel/issues/658))
- **Migration:** `202609170002_canonical_monetary_amounts`
- **Primary gate:** E-3 (data integrity)

## What the control does

Treasury stores two kinds of money, and before this change both were
unconstrained `TEXT` cast with `::numeric` at read time. `''`, `'-1'`, `'1e6'`,
`' 100 '` and `'007'` were all storable, and `'007'` and `'7'` could both
describe the same amount while comparing unequal as strings.

Two domains now make the canonical spelling the only representable one:

| Domain                 | Applies to                                                                                                                                           | Canonical form                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `treasury_raw_amount`  | `treasury_ledger_entries.amount_raw`, `sweep_batches.expected_total_raw`, `sweep_batch_entries.entry_amount_raw`, `treasury_claim_events.amount_raw` | Unsigned uint256 scaled integer, no leading zero, ≤ 78 digits        |
| `treasury_fiat_amount` | `fiat_deposit_references`, `fiat_deposit_events`, `treasury_partner_handoffs` source/expected/destination amounts                                    | Unsigned fixed-point decimal, ≤ 8 fractional digits, no leading zero |

The split is deliberate. `*_raw` columns hold the exact uint256 the escrow
emitted. The partner and fiat-ramp columns hold a provider-reported amount
always paired with a currency column (`source_currency`, `expected_currency`),
which is a decimal quantity such as `125.00` USD. Forcing both through one
constraint would either reject legitimate provider amounts or permit
fractional escrow amounts that cannot exist on chain.

`treasury/src/core/canonicalAmount.ts` applies the same two rules in the
application, so a rejection is attributable to a field and an actor before it
reaches the database.

### Allocation invariant

A sweep allocation may be partial, but it can never exceed the ledger entry it
draws from, and a zero allocation is never meaningful. This is enforced twice:

- `addSweepBatchEntry` checks it inside the allocation transaction, against the
  same ledger row the allocation is written against.
- The `sweep_batch_entries_allocation_bound` trigger enforces it for **any**
  writer, including a manual repair session.

The trigger applies to **every** allocation status, not only `ALLOCATED`. A
`RELEASED` row still records what was drawn from the ledger entry, so exempting
it would leave an unvalidated amount in the table. The bound is checked on
`UPDATE` as well as `INSERT`.

## Export contract

Use a named service API key for every snapshot operation. Shared-secret-only
authentication cannot identify an individual caller and is refused. The caller
is bound to its configured service identity. The `POST /exports` request requires
an `Idempotency-Key` header and a JSON body with one `cutoff` ISO-8601 timestamp.
The cutoff must not be in the future. Reuse the same key and cutoff to retry a
failed or abandoned job. A different cutoff with the same key returns a conflict.

The service returns the job ID and construction status. `GET /exports/:id`
returns the status, cutoff, access expiry, candidate count, raw amount total,
and failure code. A completed job also returns the captured chain, reconciliation,
and ingestion contexts. A caller has access for 24 hours after job creation.
The service retains the job metadata and completed rows after access expires.

`GET /exports/:id/entries` returns candidate rows and their recorded eligibility
decisions. Set `limit` from 1 to 1,000; the default is 500. Follow each
`nextCursor` until `complete` is true. Tokens are opaque and are bound to the
caller, job, position, and access expiry. Restart with a new job if a token is
invalid or expired. Sum the returned row amounts and compare the sum and count
with the completed job's candidate totals. Filter `eligibleForExport` when
reconciling eligible rows. Retain the per-row decisions and reasons with the
report. `exportBlockedReasons` explains each row that is not exportable. A
completed snapshot is historical evidence. Payout and sweep actions
must use current eligibility.

The default `TREASURY_EXPORT_MAX_ROWS` is 100,000. The allowed range is 5,001 to
1,000,000. A job above the configured limit fails with
`JOB_SIZE_LIMIT_EXCEEDED`; it does not publish a truncated report. If the
builder fails, inspect `failureCode`. Retry with the same idempotency key and
cutoff. A crashed worker's lease must expire before a retry can claim the job.
If the service returns `ExportCapacityExceeded`, retry the same request.

`GET /export` remains available for a single complete page. The endpoint returns
`409 ExportContinuationRequiresSnapshot` if another page is required. It also
rejects legacy continuation tokens. `allowPartial=true` does not bypass this
refusal. JSON and CSV use the same limit. Consumers must migrate and test this
compatibility change before promotion.
The legacy endpoint reads its count and rows separately. Use the snapshot
workflow when the report requires stable row identity and retained evidence.

## Retention and cleanup

Completed jobs and their rows are retained. The runtime role has no delete grant
for export tables. Do not delete accepted evidence. Archive accepted evidence
under the approved custody policy before any authorized destruction decision.
The custody policy and independent archive verification remain release gates.

A privileged operator may remove expired tokens and rows from expired failed
jobs only after the retention owner approves the procedure. Keep the job row and
its audit metadata. Do not clean an active or completed job. Run the following
transaction on the Treasury database with `app.service_name` set to `treasury`:

```sql
BEGIN;
SELECT id FROM treasury_export_jobs
WHERE status = 'FAILED' AND lease_owner IS NULL AND access_expires_at <= NOW()
FOR UPDATE;
DELETE FROM treasury_export_rows r USING treasury_export_jobs j
WHERE r.job_id = j.id AND j.status = 'FAILED' AND j.lease_owner IS NULL
  AND j.access_expires_at <= NOW();
DELETE FROM treasury_export_tokens WHERE expires_at <= NOW();
COMMIT;
```

The runtime role cannot execute this cleanup. Record the operator, approval,
cutoff, affected job IDs, and row counts. Never bypass the completed-evidence
retention triggers without a separately approved custody and destruction plan.

## Rollback

Pause exports before rolling back the service. Retain the migration and all
snapshot tables. Verify the older image can run with the additive schema. The
older `/export` pagination does not provide stable snapshot evidence, so keep it
blocked until a compatible reporting path is approved. Reconcile any in-flight
jobs and retain their metadata before resuming reporting.

## Applying the migration

The migration runs through the standard runner; no special handling:

```bash
MIGRATION_MANIFEST_PATH=treasury/dist/database/migrations.json node shared-db/migrate.js
```

**Each `ALTER COLUMN` validates every existing row.** A non-canonical legacy
value fails the migration rather than being silently rewritten: an amount nobody
can attribute is an accounting question, not a data-cleanup task.

If the migration fails on legacy data, find the offending rows before deciding
anything:

```sql
SELECT id, entry_key, trade_id, amount_raw
FROM treasury_ledger_entries
WHERE amount_raw !~ '^(0|[1-9][0-9]*)$'
   OR length(amount_raw) > 78;
```

Each row needs an owner decision recorded against its source event. Do not
coerce the value to make the migration pass.

## Verification

```bash
pnpm --filter treasury run test          # unit + contract tests
pnpm --filter treasury run typecheck
pnpm --filter treasury run lint

# Database-level constraints and export coverage need a real PostgreSQL
# instance. `ci/treasury` sets these variables against its own service
# container, so both suites run in CI rather than self-skipping.
TREASURY_POSTGRES_TESTS=true DB_HOST=127.0.0.1 DB_PORT=5432 \
  pnpm --filter treasury run test

# The manifest fingerprint must match the schema the migration produces.
node --test shared-db/schema-fingerprint.manifests.postgres.test.js
```

## Residual risk

The export's eligibility filter still evaluates the RPC head and the
reconciliation gate per page, so two pages of one export can disagree about a
row's eligibility if the chain head advances between them. The cutoff bounds
which rows are _candidates_, not how they were judged. Consumers that need a
single eligibility verdict across a whole export should compare
`exportedRowCount` totals against a repeat run at the same cutoff.
