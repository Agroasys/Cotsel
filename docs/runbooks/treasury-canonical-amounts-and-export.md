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

## Export contract

`GET /export` previously issued `getLedgerEntries({ limit: 5000, offset: 0 })`.
Row 5001 was never exported, the response was a bare array with no indication
that anything was missing, and offset paging meant a concurrent insert shifted
every later page.

The export is now a keyset page bounded by a fixed cutoff.

| Parameter      | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `cutoff`       | ISO-8601 snapshot boundary. Defaults to now. Must be restated on every page.          |
| `cursor`       | Opaque continuation from the previous page's `nextCursor`.                            |
| `limit`        | Page size, default 500, maximum 1000. An oversized limit is **refused**, not clamped. |
| `format`       | `json` (default) or `csv`.                                                            |
| `allowPartial` | `true` to accept a knowingly truncated CSV. Default `false`.                          |

The JSON envelope carries what makes the export checkable:

```json
{
  "cutoff": "2026-09-17T12:00:00.000Z",
  "snapshot": { "rowCount": 12840, "totalAmountRaw": "98230000000" },
  "scannedRowCount": 500,
  "exportedRowCount": 447,
  "exportedAmountRaw": "3220000000",
  "nextCursor": "MjAyNi0wOS0xN1QxMTo1OTowMC4wMDBafDEyMzQ=",
  "complete": false,
  "entries": []
}
```

`snapshot` counts and totals every candidate row at the cutoff.
`scannedRowCount` counts candidates on this page; `exportedRowCount` counts
those that passed the confirmation and reconciliation gates. **Summing
`scannedRowCount` across pages must equal `snapshot.rowCount`** — that is how a
consumer proves it received every record exactly once.

Continuation advances over candidates, not exported rows. A cursor taken from
exported rows would re-scan an ineligible row forever.

### Truncation is explicit

CSV has no envelope to carry a cursor, so an incomplete CSV file is
indistinguishable from a complete one once written to disk. Requesting CSV for
an export that would truncate returns **409 `IncompleteExport`** rather than a
silently short file. Page with JSON, or pass `allowPartial=true` to state that a
partial file is what you want.

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

# Database-level constraints need a real PostgreSQL instance.
TREASURY_POSTGRES_TESTS=true DB_HOST=127.0.0.1 DB_PORT=5432 \
  pnpm --filter treasury exec jest tests/canonicalAmounts.postgres.test.ts --runInBand

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
