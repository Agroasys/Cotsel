# Treasury query modules

`../queries.ts` is the stable public import surface for Treasury database
operations. Keep callers importing that barrel unless a reviewed boundary needs a
more specific dependency.

Each module owns one database concern:

- `ingestion.ts`: durable ingestion cursor and service-auth nonce operations.
- `ledger.ts`: ledger entries and payout lifecycle reads and writes.
- `accountingPeriods.ts`: accounting-period lifecycle.
- `accountingProjections.ts`: ledger accounting projections.
- `fiatDeposits.ts`: provider deposit references.
- `bankPayouts.ts`: bank payout confirmations.
- `sweepBatches.ts`: sweep batches, entries, and batch reads.
- `treasuryClaims.ts`: claims, partner handoffs, and revenue realization.
- `treasuryPartnerHandoffs.ts`: evidence-backed Treasury handoff lifecycle.

This split is an ownership boundary, not a behavior change. Preserve SQL text,
parameter order, transaction boundaries, return types, conflict handling, and the
exports from `../queries.ts` when moving an operation between modules. Run the
Treasury test suite, lint, typecheck, build, and repository source-size gate after
each change.
