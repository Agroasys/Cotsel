# Reconciliation Run Leases and Scoped Containment

How a crashed reconciliation run stops blocking treasury, and how a qualified
discrepancy is contained to the one trade it affects.

- **Owner:** Reconciliation and Platform owners
- **Traceability:** WP-3, findings H-17 and PRES-11 ([Agroasys/Cotsel#654](https://github.com/Agroasys/Cotsel/issues/654))
- **Alerts:** `RECONCILIATION_RUN_ABANDONED`, `RECONCILIATION_TRADE_CONTAINED` (both critical, pager route)

## Part 1 — Run leases (H-17)

### The problem this removes

A run row is keyed by `run_key` and marked `RUNNING` for the duration of the
sweep. Before this control, a worker that died mid-run left that row `RUNNING`
forever: the key could never be reused, the window it was covering was never
reconciled, the cursor never advanced past it, and the only way out was a manual
`UPDATE` against the reconciliation database. A `RUNNING` row also looked
healthy — nothing distinguished a run in progress from one whose process was
gone.

### How it works

Every run holds a **lease** on its row: an owner, an epoch, and an expiry.

1. **Claim.** `claimRun` inserts a new key already leased, or takes over an
   existing key that is not `COMPLETED` and not covered by a live lease. The
   takeover is one conditional `UPDATE`; two workers racing it lock the same row
   and the loser re-evaluates the predicate against the winner's committed
   lease, so **exactly one successor wins**. Each claim bumps `lease_epoch`.
2. **Heartbeat.** While the run works it extends `lease_expires_at` every
   `RECONCILIATION_LEASE_HEARTBEAT_MS`. A heartbeat that is _rejected_ (the row
   no longer matches this owner and epoch) means the run was declared abandoned
   and it stops at the next batch boundary. A heartbeat that _throws_ is treated
   as a database problem, not as loss — an unreachable Postgres says nothing
   about who owns the lease.
3. **Sweep.** Before each claim, `markAbandonedRuns` marks every `RUNNING` run
   whose lease has lapsed as `ABANDONED`, records the displaced owner, appends a
   lease event, and pages `RECONCILIATION_RUN_ABANDONED`. This runs whether or
   not anything wants the key back, so stuck work is visible on its own.
4. **Fence.** The finalizing transaction re-checks the lease under `FOR UPDATE`
   as its first statement. A displaced worker cannot publish findings, move the
   cursor, or stamp `FAILED` over its successor — the whole transaction rolls
   back and the run returns `SKIPPED` with reason `lease lost to a successor`.
5. **Release.** A run that reaches a terminal status hands the lease back inside
   the same transaction, so the next worker does not wait out a TTL. A row that
   is still `RUNNING` cannot be un-leased.

`ABANDONED` is terminal for the _attempt_, not for the run key: it is the one
status a successor may claim back into `RUNNING`.

### Configuration

| Variable                            | Default  | Meaning                                                             |
| ----------------------------------- | -------- | ------------------------------------------------------------------- |
| `RECONCILIATION_LEASE_TTL_MS`       | `300000` | Longest a crashed run holds its key before a successor may take it. |
| `RECONCILIATION_LEASE_HEARTBEAT_MS` | `30000`  | How often a live run extends its lease.                             |

Startup asserts `heartbeat * 2 <= ttl`. At one beat per TTL a single dropped
heartbeat — a slow query, a GC pause — would hand a healthy run's key to a
successor while the original worker is still writing.

Set the TTL longer than the longest expected run stall, not longer than the
longest run: the heartbeat keeps a long but healthy run alive indefinitely.

### Rows written before this control existed

A `RUNNING` row with no lease at all (written by an earlier build) is swept once
a full TTL has passed since `started_at`. Without that fallback those rows would
stay `RUNNING` forever, which is exactly the wedge this control removes.

### Operating it

Runs currently marked abandoned, and the trades currently blocked, are on the
readiness endpoint — neither changes the readiness verdict:

```bash
curl -s localhost:9090/ready | jq '{abandonedRuns, blockingContainments, lastRun}'
```

Full lease history for one run key:

```sql
SELECT event, lease_owner, previous_owner, lease_epoch, detail, created_at
FROM reconcile_run_lease_events
WHERE run_key = '<run key>'
ORDER BY id;
```

The event log is append-only precisely so a second abandonment does not
overwrite the evidence of the first.

### When `RECONCILIATION_RUN_ABANDONED` fires

1. Read `abandonedOwner` from the alert: `host:pid:id`. Check whether that host
   or task is still alive — a repeatedly abandoned key on the same host is an
   unhealthy worker, not a reconciliation problem.
2. **Do not** clear the row by hand. The window is recovered without it — but by
   which of two routes depends on the mode, and they are worth telling apart:
   - **Daemon.** The run key is time-bucketed (`daemon-<bucket>`), so the next
     cycle uses a _new_ key and never reclaims the abandoned one. Recovery comes
     from the cursor instead: the abandoned run never reached its finalizing
     transaction, so the cursor never moved, and the next run re-plans the same
     window from where the crashed one started. The abandoned row stays as
     evidence of the failed attempt.
   - **A fixed run key** (`reconcile:once --run-key=…`, or two workers landing in
     one daemon bucket). Here the successor claims the same key directly, which
     is the path that removes the manual `UPDATE`. `takeover_count` on the row
     counts how many times that has happened.
3. If the same key is abandoned repeatedly, or `takeover_count` keeps climbing,
   the run is dying part-way through rather than at random. Check the run's
   window size against the TTL, and check the worker logs for the failure that
   precedes each abandonment.
4. The cursor is safe throughout: it only ever advances inside the finalizing
   transaction of a run that still held its lease, so an abandoned run cannot
   have retired a range it did not reconcile.

## Part 2 — Scoped containment (PRES-11)

### What qualifies

Only a divergence that means the chain and the projection disagree about **who
was paid, how much, or which agreement a trade settles**:

`AMOUNT_MISMATCH`, `FEE_COMPONENT_MISMATCH`, `PARTICIPANT_MISMATCH`,
`HASH_MISMATCH`, `ONCHAIN_TRADE_MISSING`, `INDEXER_TRADE_MISSING`.

Deliberately excluded: `ONCHAIN_READ_ERROR` (inconclusive — a transient RPC
failure would otherwise pause healthy settlement), `INDEXER_SURPLUS_RECORDS`
(a whole-projection count, not attributable to one trade), `STATUS_MISMATCH`
and `ARRIVAL_TIMESTAMP_MISMATCH` (lifecycle lag), and the invalid-address codes
(an unusable value, not a proven disagreement).

The allow-list is asserted in `containment-qualification.test.ts`, so adding a
pause trigger has to be a recorded decision rather than a side effect of adding
a drift code.

### What happens

A qualifying discrepancy opens one `reconcile_trade_containments` row for that
trade, carrying a quotable incident reference (`RECON-<yyyymmdd>-<8 hex>`), the
qualifying codes, and an evidence snapshot pinned to the boundary block. Repeat
sightings fold into the standing incident rather than opening competing ones.

**Reconciliation holds no admin key and pauses nothing itself.** The escrow's
`pauseTrade(tradeId)` is an `onlyAdmin` action and resumption runs through the
on-chain timelocked unpause proposal. The `RECONCILIATION_TRADE_CONTAINED` alert
is the containment _request_, naming the one trade the scoped pause applies to.

### Lifecycle

```
CONTAINED ──(a later run reconciles the trade clean)──> RECONCILED_PENDING_APPROVAL
    ^                                                            │
    └────────(the divergence returns)────────────────────────────┘
                                                                 │
                                            (governed approval recorded)
                                                                 v
                                                             RELEASED
```

Both non-released states block. A clean read is evidence, not authority: the
trade stays blocked until a quorum-governed approval is recorded against it. The
run that opened an incident can never be the run that clears it, so "fresh
reconciliation" is enforced rather than assumed. A divergence that returns drops
the clearance evidence, so a pending approval cannot be spent on it.

### Operating it

```bash
# Everything currently blocked
pnpm --filter reconciliation run reconcile:containment list

# One trade
pnpm --filter reconciliation run reconcile:containment show --trade-id=<id>

# Release, against the recorded quorum decision
pnpm --filter reconciliation run reconcile:containment release \
  --trade-id=<id> --approval-ref=<governance record>
```

`release` refuses a trade that has not reconciled clean since the incident
opened, and refuses one with no approval reference. Record the same reference on
the on-chain unpause proposal so the two halves of the decision tie together.

### When `RECONCILIATION_TRADE_CONTAINED` fires

1. Quote `incidentReference` in every subsequent action.
2. Apply the escrow scoped pause to **that trade id only**. Do not pause the
   contract; the discrepancy is scoped and the containment record says so.
3. Preserve the evidence: `reconcile_trade_containments.evidence` holds the
   findings and the boundary block they were read at, and survives later runs
   moving the drift rows on.
4. Resolve the underlying divergence, then let a later reconciliation run
   observe the trade clean. Confirm the state reached
   `RECONCILED_PENDING_APPROVAL`.
5. Obtain the governed approval, record it with `release`, then raise the
   on-chain unpause proposal.

## Verification

```bash
pnpm --filter reconciliation run test
```

Lease and containment behaviour against real Postgres lives in
`run-leases.postgres.test.ts` (skipped when Docker is unavailable); heartbeat and
qualification logic in `run-lease-heartbeat.test.ts` and
`containment-qualification.test.ts`.

## Scope boundary

This runbook covers the reconciliation-side controls. Two things it deliberately
does **not** cover, because they are not reconciliation's to do:

- Executing the scoped pause and the quorum-governed unpause. Both are admin
  multisig actions against `AgroasysEscrow`.
- The deployed discrepancy drill and the crash-injection evidence PRES-11 and
  TEST-05 require. Those are contributed to `wp8-drills`
  ([Agroasys/Cotsel#674](https://github.com/Agroasys/Cotsel/issues/674)) against
  a pinned candidate; this issue supplies the mechanism, not the acceptance.
