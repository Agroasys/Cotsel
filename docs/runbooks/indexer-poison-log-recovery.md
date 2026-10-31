# Indexer Poison-Log Recovery

Recovery procedure for an escrow log the indexer could not project.

- **Owner:** Indexer and Data owners
- **Traceability:** WP-3, findings B-06 and FAIL-04 ([Agroasys/Cotsel#651](https://github.com/Agroasys/Cotsel/issues/651))
- **Alert:** `INDEXER_POISON_LOG` (critical, pager route) — see `notifications.md`

## What the control does

The indexer projects escrow logs into Postgres. Subsquid commits the entity
writes and the `squid_processor.status` checkpoint in a **single transaction**,
so an event that is skipped is skipped permanently: the checkpoint moves past
its block and nothing ever reprocesses it.

Three cases are treated as poison and are never skipped:

| Reason            | Cause                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNDECODABLE`     | `parseLog` threw or returned nothing for a log matching an escrow event topic. Usually ABI drift or a contract redeploy at the same address. |
| `UNKNOWN_EVENT`   | The log decoded but no projection handler exists for the event. An event was added to the ABI without a handler.                             |
| `HANDLER_FAILURE` | The projection handler threw.                                                                                                                |

On any of them the indexer:

1. Writes the **complete raw log** to `indexer_quarantined_log` on a separate
   database connection, so the row commits independently.
2. Raises a critical `INDEXER_POISON_LOG` alert.
3. Throws, which rolls back the batch transaction — including the checkpoint
   update — and exits non-zero.

The pipeline then refuses to start while any row is `UNRESOLVED`, so the
checkpoint stays held across restarts. Under `restart: unless-stopped` the
container will crash-loop; that is the intended fail-closed signal, not a
separate fault.

## Symptoms

- `indexer-pipeline` restarting with `quarantine.startup_blocked` or
  `indexer.bootstrap_failed` in its last log lines.
- Reconciliation reporting indexer-side coverage gaps.
- Trade timelines stale from a fixed block onward.

## Recovery

All commands run from `Cotsel/indexer` with the pipeline's database
environment (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`,
`DB_SSL_MODE`).

### 1. Triage

```bash
pnpm --filter indexer run quarantine list
```

Record `blockNumber`, `txHash`, `logIndex`, `reason`, `eventName`, and
`occurrences` in the incident. Do not clear rows before the cause is understood
— they are the only durable evidence of the unprojected event.

### 2. Correct the cause

| Reason            | Correction                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNDECODABLE`     | Confirm `CONTRACT_ADDRESS` and the deployed codehash against the reviewed deployment report, regenerate `indexer/src/abi/AgroasysEscrow.json` from the deployed contract, and release a new indexer image. |
| `UNKNOWN_EVENT`   | Add the projection handler for the event and release a new indexer image.                                                                                                                                  |
| `HANDLER_FAILURE` | Fix the handler and release a new indexer image.                                                                                                                                                           |

A correction is not complete until the new image is the one that will restart.

For a missing trade or proposal, verify the parent event's canonical block and projection before releasing the hold.
This requirement includes dispute, oracle update, and administrator change proposals.
Check the deployment start block and the affected replay range.
Restore the parent through a reviewed replay or data recovery procedure.
Do not create placeholder parent records or resolve quarantine to bypass missing coverage.
Replay the child event after its parent is available, then reconcile the resulting projection.

An older image can silently skip missing parents.
Keep the quarantine hold during rollback until a compatible image and replay procedure are approved.

### 3. Re-pin the contract identity (required outside local)

Update `INDEXER_EXPECTED_CONTRACT_CODEHASH` and `INDEXER_EXPECTED_ABI_FINGERPRINT`
so the next drift fails at startup rather than at the first affected log. The
values are printed by the passing preflight as `codehash` and `abiFingerprint`
in the `contract.preflight_passed` log line.

These are **not optional** when `COTSEL_ENVIRONMENT` is `staging` or
`production`: the indexer refuses to start without both, and without
`INDEXER_NOTIFICATIONS_ENABLED=true` plus a webhook. Unpinned, the preflight
degrades to "is there any code at this address", so a redeploy at the same
address would start cleanly; unrouted, a poison log holds the checkpoint
without paging anyone. In staging both come from Terraform —
`base_sepolia_escrow_codehash`, `escrow_abi_fingerprint`, and the
`notifications-webhook` secret.

### 4. Release the hold

```bash
pnpm --filter indexer run quarantine resolve \
  --block <blockNumber> --tx <txHash> --log-index <logIndex> \
  --note "ABI regenerated from deployed contract; image <digest>"
```

The note is mandatory and becomes part of the evidence record.

### 5. Replay

The checkpoint was held at the block before the poison log, so a restart
normally replays it with no rewind. Rewind only if the checkpoint is already
past the affected range (for example, evidence recovered from an older build):

```bash
pnpm --filter indexer run quarantine rewind --block <blockNumber>
```

Rewind clears hot-block bookkeeping and sets the checkpoint to
`blockNumber - 1` with the `0x` hash sentinel. The runner logs a "migrating
from the FireSquid" warning on the next start — that is expected, and safe
because we only ever rewind to a finalized height.

Restart `indexer-pipeline`. Replay is deterministic: every projection write is
an idempotent upsert, so the same range reproduces the same projection.

### 6. Verify before closing

1. `quarantine list` returns no unresolved rows.
2. The pipeline logs `contract.preflight_passed` and stays up.
3. `OverviewSnapshot.lastProcessedBlock` has advanced past the affected block.
4. Reconciliation runs clean over the affected trade range
   (`pnpm --filter reconciliation run reconcile:once`).
5. The incident records the quarantined row, the correction, the released
   image digest, and the reconciliation result.

## Do not

- Do not `DELETE` from `indexer_quarantined_log` to get the pipeline started.
  The migration's `down` refuses to drop the table while rows are unresolved
  for the same reason.
- Do not resolve a row before the corrected image is the one that will restart;
  the log will simply re-quarantine and reopen the hold.
- Do not edit `squid_processor.status` by hand. Use `quarantine rewind`.

## Related

- `notifications.md` — alert routing for `INDEXER_POISON_LOG`
- `monitoring-alerting-baseline.md`
- `chain-event-parity-retirement.md`
