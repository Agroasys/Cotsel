# Reconciliation Chain Coverage

How reconciliation proves it has compared the complete chain trade range, and what
to do when it reports a gap or a backlog.

- **Owner:** Reconciliation and Data owners
- **Traceability:** WP-3, findings B-07, FAIL-05 and FAIL-07 ([Agroasys/Cotsel#652](https://github.com/Agroasys/Cotsel/issues/652))
- **Alerts:** `RECONCILIATION_COVERAGE_GAP`, `RECONCILIATION_COVERAGE_BACKLOG` (both critical, pager route)

## What the control does

The chain is the independent enumeration authority. Trade ids are allocated
sequentially from 1 up to `tradeCounter`, so the contract alone defines the
complete id space a sweep must cover — reconciliation never asks the indexer
what exists.

Each run:

1. Resolves one **boundary block** (`finalized` by default, `safe` if configured)
   and reads `tradeCounter` **at that same block**. Both reads share a height:
   otherwise a trade created mid-run would look like a chain record the indexer
   never projected.
2. Plans a window from the persisted cursor up to the counter, bounded by
   `RECONCILIATION_MAX_TRADES_PER_RUN`. That value is a **work budget, not a
   coverage cap** — whatever the run does not reach is published as
   `uncovered_tail` and resumed next run.
3. Reads each chain trade in the window pinned to the boundary block, and asks
   the indexer for exactly those ids.
4. Compares both directions:
   - chain has it, indexer does not → `INDEXER_TRADE_MISSING` (critical)
   - indexer returns an id the window never asked for → `ONCHAIN_TRADE_MISSING` (critical)
   - both hold it → the existing field-level drift classification
   - indexer holds more trades than the chain allocated → `INDEXER_SURPLUS_RECORDS` (critical)
5. Publishes complete-range accounting on the run row and advances the cursor —
   **only if the window had no coverage gap**.

### Why the id set is driven from chain

`Trade.tradeId` is a GraphQL `String` in the indexer schema, so range and
ordering operators on it are lexicographic (`"10"` sorts before `"9"`) and
cannot express a numeric keyset. Asking the indexer for an explicit id set
sidesteps that, and any id absent from the response is a projection gap.

## Reading a completed run

```sql
SELECT run_key,
       coverage_from_trade_id, coverage_to_trade_id,
       coverage_from_block, coverage_to_block,
       chain_trade_counter, next_cursor,
       uncovered_tail, coverage_complete,
       critical_count
FROM reconcile_runs
ORDER BY started_at DESC
LIMIT 5;
```

- `coverage_complete = true` and `uncovered_tail = 0` — the run compared the
  entire chain range up to its boundary block.
- `coverage_complete = false` — the run was budget-bounded. This is normal
  throughput while `uncovered_tail` shrinks run over run; it is **not** a clean
  sweep and must not be treated as one for close purposes.
- `next_cursor` is where the following run resumes.

## `RECONCILIATION_COVERAGE_GAP`

A chain trade the indexer never projected (FAIL-05), or an indexer surplus.

The cursor is **held** at its previous value while any gap is unresolved, so
successive runs keep re-detecting it rather than advancing past it and reporting
clean. Reconciliation does not progress until the projection is repaired.

### Recovery

1. Identify the affected ids:

   ```sql
   SELECT trade_id, mismatch_code, details
   FROM reconcile_drifts
   WHERE mismatch_code IN ('INDEXER_TRADE_MISSING', 'INDEXER_SURPLUS_RECORDS')
   ORDER BY updated_at DESC;
   ```

2. Treat the affected trades as frozen for downstream progression until the
   projection is repaired and a fresh run accepts the range. Record the incident
   reference alongside the drift rows.
3. Repair the indexer. A missing projection is almost always an indexer-side
   fault — check for a held checkpoint or quarantined log first
   (`indexer-poison-log-recovery.md`), then backfill or replay the **complete**
   affected block range rather than the single trade.
4. Re-run reconciliation over the same window:

   ```bash
   pnpm --filter reconciliation run reconcile:once
   ```

5. Confirm the gap is gone, the cursor advanced past the range, and
   `critical_count = 0` for the new run before closing the incident.

## `RECONCILIATION_COVERAGE_BACKLOG`

The uncovered tail has not shrunk within `RECONCILIATION_COVERAGE_MAX_AGE_MS`.
The sweep can no longer keep up with the rate trades are being created.

The age clock starts when a non-empty tail is first observed and resets when the
tail returns to zero, so ordinary bursts do not page anyone.

### Recovery

1. Confirm the tail is genuinely growing rather than a one-off burst:

   ```sql
   SELECT started_at, uncovered_tail::text, coverage_complete
   FROM reconcile_runs
   ORDER BY started_at DESC
   LIMIT 20;
   ```

2. Pause pilot expansion while the backlog persists — new trades widen the gap.
3. Increase capacity: raise `RECONCILIATION_MAX_TRADES_PER_RUN` (bigger budget
   per run), raise `RECONCILIATION_CHAIN_READ_CONCURRENCY` (more parallel chain
   reads, bounded by the RPC provider's limits), or shorten
   `RECONCILIATION_DAEMON_INTERVAL_MS`.
4. Let the backlog drain until a run reports `coverage_complete = true`, then
   restore the previous settings.

## Configuration

| Variable                                | Default     | Meaning                                                                           |
| --------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `RECONCILIATION_MAX_TRADES_PER_RUN`     | `1000`      | Per-run work budget. Not a coverage cap.                                          |
| `RECONCILIATION_BATCH_SIZE`             | `100`       | Ids per chain/indexer request batch.                                              |
| `RECONCILIATION_COVERAGE_BOUNDARY`      | `finalized` | Block tag every read in a run is pinned to. `safe` trades finality for freshness. |
| `RECONCILIATION_COVERAGE_MAX_AGE_MS`    | `3600000`   | Age SLA over the uncovered tail.                                                  |
| `RECONCILIATION_CHAIN_READ_CONCURRENCY` | `8`         | Parallel chain reads per batch.                                                   |

## Do not

- Do not raise `RECONCILIATION_MAX_TRADES_PER_RUN` to hide a backlog alert. The
  alert is about the tail outliving its SLA, and a bigger budget without more
  capacity just moves the bound.
- Do not edit `reconcile_cursors` by hand to skip a gap. The hold is the control:
  advancing past an unreconciled range retires the evidence that a chain trade
  was never projected.
- Do not treat `coverage_complete = false` as a clean run.

## Related

- `notifications.md` — alert routing
- `indexer-poison-log-recovery.md` — the usual upstream cause of a coverage gap
- `monitoring-alerting-baseline.md`
