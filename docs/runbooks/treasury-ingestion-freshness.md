# Treasury Ingestion Freshness and the Single-Owner Worker

The scheduled ingestion loop, the freshness watermark that readiness and export
fail closed against, and the stopped-ingestion drill.

- **Owner:** Treasury and Finance owners
- **Traceability:** WP-4, finding B-09 and controls FAIL-10, H-25 ([Agroasys/Cotsel#656](https://github.com/Agroasys/Cotsel/issues/656))
- **Migration:** `202609190005_ingestion_freshness_worker`
- **Primary gate:** E-3 (data integrity)

## What the control does

Ingestion had no owner and no clock.

`--ingest-once` existed and `POST /internal/ingest` existed, but nothing in the
deployment called either, so chain evidence advanced only when a person asked
for it. And `treasury_ingestion_state` recorded _where_ the last run reached
without recording _when_, so a stopped ingester and a caught-up ingester wrote
the same row. `/health` and `/ready` knew nothing about either, which is the
finding: treasury stayed green indefinitely while export, realization and close
kept clearing entries against fee evidence that had stopped advancing.

The data was never wrong. What was missing is that **stale ingestion does not
make any stored entry wrong; it makes the absence of a later entry
meaningless.** Nothing in a per-entry assessment can notice that, so it has to
be asserted about the feed itself.

| Change                 | Where                                      | What it guarantees                                                              |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Scheduled single owner | `TreasuryIngestionWorker`                  | One replica ingests at a time, on a fixed delay, and says so when it declines.  |
| Freshness watermark    | `treasury_ingestion_state.last_success_at` | Only a completed run advances it; refusals and throws leave it where it was.    |
| Append-only run log    | `treasury_ingestion_runs`                  | Every attempt leaves evidence naming its owner, window and stop reason.         |
| Readiness gate         | `GET /ready`                               | Readiness turns unhealthy, with the cause on the probe, once freshness lapses.  |
| Export and payout gate | `TreasuryEligibilityService`               | Every entry carries the ingestion outage as a blocked reason while it persists. |

### Ownership is a lease, not a queue

The worker takes `pg_try_advisory_lock` — non-blocking — around each run. A
second replica that cannot take it skips its tick and records `NOT_OWNER`.

Blocking would be wrong twice over. A queued tick would eventually run against
a head that has since moved, and overlapping runs would interleave their
watermark writes. Recording the declined tick matters too: _"the schedule is
alive but not mine"_ and _"the schedule is dead"_ must not look the same in the
evidence.

The loop schedules the next run **after** the previous one settles, rather than
at a fixed rate. A fixed rate would stack ticks behind a slow run and the lease
would turn every stacked tick into a declined one — a worker that looks busy
while ingesting nothing.

### Why liveness stays green

`/health` is liveness and does not consult ingestion. `/ready` is readiness and
does.

Restarting a pod does not restart the chain. If an ingestion outage turned
liveness red, an orchestrator would sit in a restart loop that cannot fix the
cause, and the compose healthcheck (`docker-compose.services.yml`, which polls
`/health`) would take the service down instead of reporting it unfit. What must
change is the signal that says treasury is fit to be exported, realized and
closed against.

### Why freshness does not read the chain

`TreasuryIngestionFreshnessService.assess()` reads the cursor, not the
settlement RPC. Readiness is probed continuously, and **an RPC outage is a cause
of staleness** — a detector that depended on the chain would fall silent exactly
when the alarm is due.

Callers that already hold a finalized head pass it in and get the block-lag
check as well. `TreasuryEligibilityService` does this: it reads the three heads
once per assessment for the confirmation stage and reuses the finalized one, so
both halves of a verdict are judged against the same view of the chain.

### Verdicts

| Status      | Meaning                                                                   | Blocks |
| ----------- | ------------------------------------------------------------------------- | ------ |
| `FRESH`     | Both cursors completed inside the age threshold and inside the lag bound. | No     |
| `STALE`     | The oldest cursor is past the age threshold, or lag exceeds the bound.    | Yes    |
| `NEVER_RUN` | A cursor row is absent, or no run has ever completed for it.              | Yes    |
| `UNKNOWN`   | The ingestion state could not be read.                                    | Yes    |

Both cursors advance in the same run, so **the furthest-behind cursor governs**.
A fresh `trade_events` beside a stalled `claim_events` is a stalled ingester,
and reporting the newer success would let one cursor mask the other's outage.

### Progress is not coverage

A run bounded by `TREASURY_INGEST_MAX_EVENTS` stops below the window it was
aiming at. It read everything it claims to have read, so it is recorded as
`PARTIAL` with the coverage it actually reached — but it does **not** advance
`last_success_at`, because freshness is the claim that treasury is level with
the chain and a capped run has not established that.

Coverage is always derived from where each cursor landed, never from the window
target. The resume height is the first block not fully consumed, so everything
strictly below it was read whole; the run reports the lower of the two cursors.
A capped run is not a failure either, so it does not drive the failure counter —
what escalates it is the freshness threshold, and the lag alarm before that.

A persistently capped ingester therefore goes stale exactly like a stopped one,
which is the point: both are behind the chain, and export must not clear against
either. `last_partial_reason` is what tells the operator which of the two it is —
one needs restarting, the other needs a bigger window or a shorter interval.

`NEVER_RUN` is separated from `STALE` because the operator action differs: one
is a deployment that has not started ingesting, the other is an ingester that
stopped. Existing rows keep `last_success_at IS NULL` after the migration
rather than adopting `updated_at`, which moves on refused runs too and would
assert a freshness no run ever proved.

## Configuration

| Variable                            | Default | Meaning                                                            |
| ----------------------------------- | ------- | ------------------------------------------------------------------ |
| `TREASURY_INGESTION_WORKER_ENABLED` | `true`  | Schedules the loop. Refused at startup when `NODE_ENV=production`. |
| `TREASURY_INGEST_INTERVAL_MS`       | `60000` | Delay between the end of one run and the start of the next.        |
| `TREASURY_INGEST_MAX_AGE_SECONDS`   | `900`   | Age past which freshness blocks. Must exceed the interval.         |
| `TREASURY_INGEST_MAX_LAG_BLOCKS`    | `300`   | Blocks behind the finalized head that eligibility tolerates.       |

A threshold shorter than the schedule is unsatisfiable — evidence would be stale
before the next run could refresh it, so export would never open — and
`loadConfig` refuses that combination at startup rather than at the first
blocked export.

Treasury also needs its **own** settlement RPC (`TREASURY_RPC_URL`,
`TREASURY_CHAIN_ID`, optionally `TREASURY_RPC_FALLBACK_URLS` and
`TREASURY_RPC_QUORUM`). Ingestion is bounded by the finalized head, so without
one every run refuses with _"Settlement RPC did not report a finalized head"_,
freshness decays and export stays blocked service-wide.

## Running the stopped-ingestion drill

The drill proves that stopping ingestion turns readiness unhealthy, blocks
export, and that the repair is provable afterwards.

1. **Establish a baseline.** With the worker running, confirm `GET /ready`
   returns `200` with `ingestion.status = "FRESH"` and a non-null
   `lastSuccessAt`. Record `ingestedThroughBlockNumber`.

2. **Stop ingestion.** Either set `TREASURY_INGESTION_WORKER_ENABLED=false` and
   restart the replica, or make the settlement RPC unreachable. The second is
   the more faithful rehearsal: runs continue and refuse, which is the common
   production shape.

3. **Observe the alarm before the stop.** `treasury_ingestion_freshness` logs at
   `warn` while `consecutiveFailureCount > 0` and at `error` once the age or lag
   threshold is exceeded. `treasury_ingestion_runs_total` records every attempt,
   including refusals, so the run log keeps advancing while coverage does not.

4. **Observe the stop.** After `TREASURY_INGEST_MAX_AGE_SECONDS`:
   - `GET /ready` returns `503`, `ingestion.status = "STALE"`, with
     `blockedReasons` naming the age and the last refusal.
   - `GET /health` still returns `200`.
   - `GET /export` and every eligibility read report `eligibleForExport = false`
     with the same reason on every entry.
   - Accounting-period close is refused on the same ground.

5. **Confirm the evidence.** Every attempt during the outage appears in
   `treasury_ingestion_runs` with `outcome` of `BLOCKED` or `FAILED` and
   `ingested_through_block_number IS NULL`. The table's
   `treasury_ingestion_runs_outcome_consistent` constraint refuses to record a
   coverage height for a run that did not complete, so the log cannot be read as
   proving a window nothing read.

6. **Repair and backfill.** Restore the RPC or re-enable the worker, then run
   the backfill explicitly:

   ```bash
   pnpm --filter treasury run ingest:once
   ```

   This takes the same lease, advances the same watermark and writes the same
   append-only evidence with `trigger_source = 'CLI'`. It exits non-zero unless
   the run completed, so a scheduler or release gate can read the exit code as
   the answer to "did treasury take in the evidence it was asked for". A
   backfill that repaired the data without recording it would leave readiness
   red, which reads as an unrepaired outage.

7. **Confirm recovery.** `GET /ready` returns `200` with `FRESH`,
   `consecutiveFailureCount` back to `0`, `lastBlockedReason` cleared, and
   `ingestedThroughBlockNumber` at or beyond the finalized range that elapsed
   during the outage. Export re-opens for entries that are otherwise clear.

Re-reading a range is safe and deliberate: `entry_key` makes every ledger upsert
idempotent, so a backfill over an already-covered window inserts nothing new.

## Applying the migration

`202609190005_ingestion_freshness_worker` is additive — four columns on
`treasury_ingestion_state` and one new table — and needs no backfill.

It is safe under a rolling upgrade. A pod running the previous image writes only
the columns it knows about and never reads the new ones; a pod running the new
image writes both. The one visible effect on the first new pod is that
`last_success_at` starts `NULL`, so **readiness is red until the worker
completes its first run**. That is the intended fail-closed default, and with
the worker enabled it clears within one interval. Because the compose
healthcheck polls `/health`, this does not hold up container startup.

```bash
docker compose -f docker-compose.migrations.yml run --rm treasury-migrate
```

## Failure handling

| Symptom                                           | Cause                                             | Action                                                                    |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `NEVER_RUN` after deploy                          | Worker disabled, or first run has not completed.  | Check `TREASURY_INGESTION_WORKER_ENABLED`; wait one interval; check logs. |
| `STALE` with _"did not report a finalized head"_  | Settlement RPC unreachable or not configured.     | Restore `TREASURY_RPC_URL`; backfill; confirm recovery.                   |
| `STALE` with _"did not report a processed block"_ | Indexer behind or unreachable.                    | Repair the indexer first; ingestion is bounded by it deliberately.        |
| `STALE` on lag alone                              | Ingestion running but not keeping up.             | Raise `TREASURY_INGEST_BATCH_SIZE`/`MAX_EVENTS`, or shorten the interval. |
| Every tick `NOT_OWNER`                            | Another replica owns the lease, or a run is hung. | Check the run log for that owner's last completed run before intervening. |
| `UNKNOWN`                                         | Treasury database unreachable.                    | Database incident; readiness is already red on the connection check.      |

Raising `TREASURY_INGEST_MAX_AGE_SECONDS` to clear a red probe is not a repair.
It widens the window in which export can clear entries against evidence that has
stopped advancing, which is the finding itself. Any such change needs a recorded
authority, expiry and compensating control.

## Rollback and containment

The worker holds no state of its own, so disabling it rolls back cleanly — but
disabling it **is** the outage, not a mitigation: freshness decays and export
fails closed service-wide within one threshold. Rolling back the migration is
not required for a code rollback; the columns and table are inert to a previous
image.

If ingestion is found to have been stopped while exports cleared, treat it as a
containment event: freeze the affected batches, re-run ingestion over the
finalized range, re-run reconciliation, and resume only after an approved
correction and a fresh reconciliation result. Incident owner is the Treasury
Owner, with the Incident Commander for a declared incident.

## Verification

```bash
pnpm --filter treasury run typecheck
pnpm --filter treasury run lint
pnpm --filter treasury run test

# The schema-level guarantees need a real PostgreSQL instance.
TREASURY_POSTGRES_TESTS=true pnpm --filter treasury exec jest \
  tests/ingestionFreshness.postgres.test.ts --runInBand
```

| Suite                                          | Proves                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `ingestionFreshness.test.ts`                   | Verdicts, the furthest-behind rule, lag, and failing closed on an error. |
| `ingestionWorker.test.ts`                      | Lease ownership, outcome recording, and lock release on every path.      |
| `readinessIngestionFreshness.test.ts`          | Readiness turns red and names the cause while liveness stays green.      |
| `exportEligibility.ingestionFreshness.test.ts` | A finalized, canonical, reconciled entry is still blocked while stale.   |
| `ingestionFreshness.postgres.test.ts`          | The drill end to end: append-only log, constraint, real advisory lock.   |

## Scope boundary

This control decides whether treasury's **own** chain evidence is current enough
to act on. It does not decide whether a trade reconciles (`reconciliationGate`),
whether an entry is still on the chain
([canonical chain evidence](./treasury-canonical-chain-evidence.md)), or whether
an external provider completed a payout. Those are separate gates and a fresh
ingestion verdict does not substitute for any of them.

## Residual risk

Freshness proves that ingestion completed a window, not that the window
contained everything the chain emitted. Coverage beyond the watermark is
reconciliation's claim, not this control's, and the bidirectional chain-derived
coverage it depends on is tracked separately in WP-3.
