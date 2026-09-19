# Treasury Realization and the Reconciliation Watermark

Why a fresh, drift-free reconciliation run is not on its own enough to realize
revenue, and what a realization record now has to name.

- **Owner:** Treasury and Finance owners
- **Traceability:** WP-4, finding H-25 ([Agroasys/Cotsel#656](https://github.com/Agroasys/Cotsel/issues/656))
- **Migration:** `202609190007_realization_reconciliation_binding`
- **Primary gate:** E-3 (data integrity)

## What the control does

Realization required a completed external handoff and a confirmed bank payout,
and the eligibility read beside it required a reconciliation run that was recent
and drift-free. None of that established that the run had **reached** the entry
being realized.

A reconciliation run is evidence about the block range it covered and nothing
else. A run that was fresh, in scope and clean, but stopped below an entry, said
nothing whatsoever about that entry — and downstream that was indistinguishable
from a run that had checked it and found it clean. The realization record kept
no trace of which run it relied on either, so the gap could not be found
afterwards.

Three claims were being collapsed into one:

| Claim                          | Answered by                                    |
| ------------------------------ | ---------------------------------------------- |
| The run is recent enough       | `completed_at` against the freshness threshold |
| The run found nothing wrong    | `reconcile_drifts` for the trade               |
| **The run reached this entry** | `coverage_to_block` against the entry's block  |

Only the third is new, and it is the one that makes the other two mean anything
about a specific entry.

## Where the watermark comes from

`reconcile_runs.coverage_from_block`, `coverage_to_block` and
`coverage_complete` are published by the reconciliation service at the end of a
run (WP-3's chain-coverage work). Treasury reads them through
`ReconciliationGateService`, which already holds a read-only connection to the
reconciliation database, and carries them into every gate it returns.

Two refusals come from the run itself, before any entry is considered:

- `coverage_complete = false` — the run published a **truncated** range. A
  truncated sweep clears every trade it happened to reach and says nothing about
  the ones it did not.
- `coverage_to_block IS NULL` — the run published no watermark, so it cannot be
  bound to anything. This is the state of runs recorded before chain coverage
  existed, and it fails closed.

Coverage is reported separately from freshness. A run can be current and still
have published no watermark, and calling that `STALE` would send an operator to
look at the schedule instead of at the run.

## Where it is enforced

| Layer                        | Effect                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| `ReconciliationGateService`  | Blocks every trade when the run's range is incomplete or unpublished.      |
| `TreasuryEligibilityService` | Blocks an entry whose block is above the run's watermark, naming both.     |
| `assertRealizationAllowed`   | Refuses realization with no binding, or a watermark below the entry block. |
| `revenue_realizations`       | Stores the run key, the watermark and the entry block, with a constraint.  |

The realization write does **not** trust the binding it is handed. The caller
supplies the run it read — reconciliation is a different database, so the read
has to happen outside the write — but the entry's own block is re-derived inside
the transaction before the comparison is stored. A caller cannot assert coverage
for a block the entry is not in.

`revenue_realizations_reconciliation_binding_complete` then refuses a **partial**
claim: citing a run without saying how far it reached, citing a watermark that
names no run, or citing a watermark below the block it is supposed to cover.
Those would read as binding evidence while proving nothing.

The three columns are nullable, because rows written before this control exist
and cannot be retrofitted with evidence nobody recorded. All three NULL together
is the shape that identifies a pre-control realization, and the evidence bundle
can find them by exactly that.

## Applying the migration

`202609190007_realization_reconciliation_binding` adds three nullable columns and
one constraint to `revenue_realizations`. It is additive, needs no backfill, and
is safe under a rolling upgrade: a previous image writes none of the three
columns, which satisfies the constraint's all-NULL branch.

```bash
docker compose -f docker-compose.migrations.yml run --rm treasury-migrate
```

## Running the out-of-scope drill

1. **Baseline.** With a completed run whose `coverage_to_block` is at or above
   the entry's block, confirm the entry reports `eligibleForPayout: true`, and
   that `GET /reconciliation/control-summary` names `latestCompletedRunKey`,
   `coverageToBlock` and `coverageComplete`.

2. **Move the watermark below the entry.** Set the latest completed run's
   `coverage_to_block` below the entry's `block_number`. The entry now reports
   `eligibleForPayout: false`, with the reason naming the entry block, the run
   key and the watermark. Realization is refused with the same comparison.

3. **Publish a truncated range.** Set `coverage_complete = false`. Every trade
   blocks with _"published an incomplete chain range"_, regardless of drift.

4. **Remove the watermark.** Set `coverage_to_block = NULL`. Every trade blocks
   with _"did not publish a chain coverage watermark"_, and `freshness` still
   reads `FRESH` — coverage and freshness are separate signals.

5. **Restore and realize.** Return the run to a complete range at or above the
   entry block. The entry clears, and the realization row records
   `reconciliation_run_key`, `reconciliation_coverage_to_block` and
   `entry_block_number`. That row is the acceptance evidence: it names the exact
   run and the exact block.

6. **Try to forge it.** Insert a realization citing a run with no watermark, or
   a watermark below the entry block. The constraint refuses both.

## Failure handling

| Symptom                                               | Cause                                                           | Action                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| Every entry blocks on _"no chain coverage watermark"_ | Runs predate chain coverage, or the sweep is not publishing it. | Run reconciliation on the current release.                 |
| Every entry blocks on _"incomplete chain range"_      | The sweep is truncating.                                        | This is WP-3's coverage work; do not relax the gate.       |
| Only high-block entries block                         | Reconciliation is behind the chain.                             | Let the sweep catch up; the gate clears on its own.        |
| Realization refused while eligibility says clear      | The gate cleared, the run moved since.                          | Re-read; the binding is taken at write time, deliberately. |

Raising the entry above the watermark by editing `coverage_to_block` is not a
repair. It asserts coverage that no run performed, and the realization row will
carry that assertion as evidence.

## Rollback and containment

The migration is inert to a previous image and does not need reverting for a
code rollback. Rolling the code back re-opens the defect: realizations would
again be accepted against runs that never reached the entry, and would record no
binding.

If a realization is found that was cleared by a run which did not cover it,
treat it as a containment event: freeze the affected batch, re-run reconciliation
over the full range, and resume only after an approved correction and a fresh
reconciliation result. Pre-control realizations (all three columns NULL) are not
evidence of a defect — they are evidence of an absence, and need re-derivation
rather than reversal.

## Verification

```bash
pnpm --filter treasury run test

TREASURY_POSTGRES_TESTS=true pnpm --filter treasury exec jest \
  tests/realizationBinding.postgres.test.ts --runInBand
```

| Suite                                               | Proves                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `accountingPolicy.test.ts`                          | Realization refuses a missing binding and a short watermark.            |
| `exportEligibility.reconciliationWatermark.test.ts` | Eligibility blocks above the watermark and on an incomplete range.      |
| `reconciliationGate.test.ts`                        | The gate reads and reports the run's published range.                   |
| `realizationBinding.postgres.test.ts`               | The stored binding cannot be partial, forged, or below the entry block. |

## Scope boundary

This control decides whether an accepted reconciliation run is evidence about a
given entry. It does not decide whether the run's comparison was correct, and it
does not make the sweep cover more ground — the bidirectional chain-derived
coverage it reads is WP-3's, tracked in
[Agroasys/Cotsel#652](https://github.com/Agroasys/Cotsel/issues/652).

## Residual risk

The watermark is only as good as the coverage the sweep actually achieved. While
#652 is open, a run can publish a complete range over a bounded set of trades;
this control binds realization to what the run claimed to reach, and the claim's
own completeness is accepted there, not here.
