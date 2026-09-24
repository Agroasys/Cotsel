# Treasury Canonical Chain Evidence and Reorganization Handling

Finalized-bounded fee ingestion, block-hash canonicality, and the revocation
path that removes orphan eligibility.

- **Owner:** Treasury and Finance owners
- **Traceability:** WP-4, finding B-08 and control FAIL-06 ([Agroasys/Cotsel#655](https://github.com/Agroasys/Cotsel/issues/655))
- **Migration:** `202609190004_canonical_chain_evidence`
- **Primary gate:** E-3 (data integrity)

## What the control does

A treasury ledger entry recorded `block_number` and `tx_hash`. Eligibility was
decided by comparing that number against the finalized head
(`resolveSettlementConfirmationStage`), which answers only "is this deep
enough". It cannot answer "is this still on the chain", because **a height
survives a reorganization unchanged**. An entry read from a block that later
lost the canonical chain reported the same number afterwards, stayed eligible
for payout and external handoff, and nothing stored on the row could ever
contradict it.

Ingestion made the same assumption in a second way: it paged the indexer's
whole event set through a row offset. An offset is a position in a set, so when
a reorganization removed events below the cursor, every later event shifted
down into the range already consumed and was never ingested.

Three changes close both:

| Change                      | Where                                        | What it guarantees                                                                                 |
| --------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Finalized-bounded ingestion | `TreasuryIngestionService`                   | Evidence below the finalized head only. No finalized head means no ingestion.                      |
| Block watermark cursor      | `treasury_ingestion_state.next_block_number` | Resume position is a chain height, not a set position, and can be rewound.                         |
| Re-verified chain identity  | `ChainCanonicalityVerifier`                  | Eligibility requires the transaction receipt to still match the ingested block hash and log index. |

### Where the block hash comes from

The indexer is not asked for it. `TradeEvent` in the indexer GraphQL schema
carries no `blockHash`, and adding one would only produce a second copy of a
claim treasury already has. The hash is read from the settlement RPC instead —
`getBlock(n)` at ingestion, and `getTransactionReceipt(txHash)` before export —
so the verdict is independent of the indexer. A poison log, an indexer bug or a
replayed event cannot launder an orphaned block into eligibility, because
nothing the indexer says is part of the check.

That RPC is the managed provider from `createSettlementProvider`, built once
for the whole service. With `RPC_FALLBACK_URLS` and `RPC_QUORUM` set it is an
ethers `FallbackProvider`, so a single provider disagreeing about a block
cannot decide a payout on its own — this is the provider-comparison half of
FAIL-06.

### The canonicality axis

`canonicality_state` is deliberately **not** another payout lifecycle state.

| State        | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `UNVERIFIED` | Identity stored, verdict not yet reached. Blocks payout and export.     |
| `CANONICAL`  | A receipt re-verification matched the block hash and the log.           |
| `ORPHANED`   | The chain contradicted the entry. Revoked until an approved correction. |

Revocation has to hold for an entry whose lifecycle has already reached
`EXTERNAL_EXECUTION_CONFIRMED` and can no longer transition. Money that has left
cannot be un-sent by a state write, so the lifecycle records `CANCELLED` only
where that transition is legal, and eligibility is removed on the canonicality
axis in every case.

`CANONICAL` is only ever assigned by the verifier, never by ingestion. The
database enforces the same rule:
`treasury_ledger_entries_canonical_requires_identity` rejects a `CANONICAL` row
without `block_hash`, `log_index`, `log_address`, `log_identity_hash` and
`canonicality_verified_at`.

A verdict is a proof about one exact row, so it survives only a byte-identical
re-ingest. If any field it covered changes — including `amount_raw` — the entry
drops back to `UNVERIFIED` and must earn `CANONICAL` again from the chain. This
is what stops a later source correction from moving the payable amount
underneath a recorded proof.

The promotion itself takes a row lock and returns the state the row ended in.
A concurrent assessment can orphan an entry between the read that produced a
verdict and the write that records it; the caller fails closed on anything other
than `CANONICAL` rather than treating a revoked entry as eligible.

### What counts as a mismatch

`ChainCanonicalityVerifier.verify` asks the receipt, not the height, because
asking for block _n_ returns whatever now occupies that height and answers
happily. Any of these orphans the entry:

| `mismatch_reason`       | Observed                                               |
| ----------------------- | ------------------------------------------------------ |
| `RECEIPT_MISSING`       | The transaction has no receipt on the canonical chain. |
| `RECEIPT_REVERTED`      | The receipt is no longer successful.                   |
| `BLOCK_NUMBER_MISMATCH` | The transaction was re-mined at a different height.    |
| `BLOCK_HASH_MISMATCH`   | The height now holds a different block.                |
| `LOG_IDENTITY_MISMATCH` | The receipt no longer carries the ingested log index.  |

An RPC outage or an entry with no stored identity yields `UNVERIFIED`, never
`ORPHANED`. **An unreachable provider is not evidence of a reorganization**, but
it is not clearance either: both block payout.

### What a revocation writes

`recordLedgerEntryOrphaned` writes in one transaction:

1. An append-only row in `treasury_chain_reorg_events` — expected and observed
   block hash, observed height and log index, `reorg_depth`, the
   `stable_block_number` it was measured against, and the reason.
2. `canonicality_state = 'ORPHANED'` on the ledger entry, with the depth and
   observed hash.
3. A `CANCELLED` payout lifecycle event, where that transition is legal.
4. A rewind of `treasury_ingestion_state.next_block_number` to the affected
   height, so the canonical events now at that height are replayed.

A partial write here is the failure the control exists to prevent: an entry
marked orphaned with no evidence cannot be reviewed, and evidence with no
revocation leaves the entry payable.

### The sweep batch path

Accrued fees leave treasury through sweep batches, so a batch must never commit
value against an entry the chain no longer contains. Each decision re-derives
the verdict from the chain in the controller, then re-checks the persisted
`canonicality_state` inside the transaction that writes it, with the entries
share-locked. An orphaning takes the same rows `FOR UPDATE`, so it either
commits first and is refused, or waits until the decision has committed.

| Decision                              | Requirement                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Allocate an entry                     | Eligible for payout (finalized, canonical, reconciled)                                                          |
| Request approval (`PENDING_APPROVAL`) | Every allocated entry eligible for payout                                                                       |
| Approve (`APPROVED`)                  | Every allocated entry eligible for payout                                                                       |
| Mark executed (`EXECUTED`)            | The `TreasuryClaimed` transaction is a successful receipt at the reported block, at or below the finalized head |
| Close (`CLOSED`)                      | Every allocated entry still `CANONICAL`                                                                         |

`DRAFT` and `VOID` stay open, so a blocked batch can always be withdrawn.
`EXECUTED` and `HANDED_OFF` record facts that already happened and are not
refused on entry state; an entry orphaned after execution is caught at close,
which is where the batch stops for the correction decision.

`UNVERIFIED` is refused as firmly as `ORPHANED`. A refusal returns `409
SweepEligibilityBlocked` naming each blocked entry and its reasons.

## Running the reorganization drill

```bash
# 1. Baseline: counts and the stable block they are quoted against.
curl -s "$TREASURY/api/v1/chain/canonicality-summary" | jq

# 2. Orphan an ingested fee event on the rehearsal chain, then re-assess.
#    Any read that assesses eligibility re-verifies; /entries is enough.
curl -s "$TREASURY/api/v1/entries?tradeId=$TRADE_ID" | jq '.data[].eligibility'

# 3. The entry is now ORPHANED with a depth, and the evidence row exists.
curl -s "$TREASURY/api/v1/chain/canonicality-summary" | jq '.data.reorgEvents[0]'
```

The acceptance evidence for B-08 is that step 3 shows `eligibleForPayout:
false` with a `canonicalityState` of `ORPHANED`, and that a later assessment —
even one where the chain agrees again — does not restore it. Re-ingesting the
same `entry_key` does not restore it either: the ledger upsert declines the
conflict update for an orphaned row.

Returning an entry to service is an approved correction with a named authority,
not a retry. There is no API for it by design.

For the sweep path (PRES-05), orphan an entry already allocated to a batch in
`PENDING_APPROVAL` and attempt approval. The acceptance evidence is a `409
SweepEligibilityBlocked` naming that entry, the batch still in
`PENDING_APPROVAL` with no new transition-actor row, and a successful `VOID`.
Repeat after execution: close must refuse the batch while the entry is
orphaned.

## Applying the migration

```bash
MIGRATION_MANIFEST_PATH=treasury/dist/database/migrations.json node shared-db/migrate.js
```

This is the **expand** half of an expand/contract rollout. `next_offset` is
kept, so a pod still running the previous image keeps working while the
deployment replaces pods one at a time. Dropping it in this migration would
break every not-yet-replaced pod with `column next_offset does not exist` the
moment the migration landed.

The two cursors do not interfere: an old pod advances only `next_offset`, a new
pod advances only `next_block_number`. An offset does not identify a block, so
nothing is translated — `next_block_number` starts at 0 and the next run re-reads
from the start of the range. That is deliberate and safe: `entry_key` makes every
ledger upsert idempotent, and the second pass is what backfills the chain
identity onto rows migrated as `UNVERIFIED`.

### Contract step (a later release)

Only after every pod runs an image with the block watermark:

```sql
-- Verify no writer has touched the old cursor since the rollout.
SELECT cursor_name, next_offset, next_block_number, updated_at
FROM treasury_ingestion_state;

ALTER TABLE treasury_ingestion_state DROP COLUMN next_offset;
```

### Index rollout

This migration deliberately adds **no** index to `treasury_ledger_entries`. A
plain `CREATE INDEX` holds a `SHARE` lock for the length of the build, which
blocks every `INSERT` and `UPDATE` on the ingestion and payout path, and this
migration runner executes each migration inside a single transaction, so
`CREATE INDEX CONCURRENTLY` is not available to it. Nothing added here filters
on `canonicality_state` — the verifier reads entries by id, export pages on
`(created_at, id)`, and the operator summary is a full aggregate — so there is
no index to justify stalling fee ingestion for. The indexes this migration does
create are on `treasury_chain_reorg_events`, a new and empty table, where the
build is instant.

If a canonicality-filtered scan is added later, build its index concurrently in
a non-transactional step and verify with:

```sql
SELECT indexrelid::regclass AS index, indisvalid, indisready
FROM pg_index
WHERE indrelid = 'treasury_ledger_entries'::regclass;
```

An index left `indisvalid = false` by a failed concurrent build must be dropped
and rebuilt; it is not used by the planner but still costs every write.

Existing rows are **not** assumed canonical. Nothing on them supports the
stronger claim, so they stay `UNVERIFIED` — and therefore blocked — until
ingestion re-reads them and the verifier clears them. Plan the first run after
this migration to complete before an export or close is expected.

Bound the catch-up with `TREASURY_INGEST_MAX_EVENTS` if the finalized range is
large. A run stops on a whole-block boundary, never mid-block, so a partly
consumed block is re-read rather than stepped over.

## Failure handling

| Symptom                                                                                         | Cause                                                                                 | Action                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /internal/ingest` returns 503 `SettlementUnavailable`                                     | No finalized head from the settlement RPC                                             | Fail-closed by design. Restore RPC reachability; check `RPC_URL`, `RPC_FALLBACK_URLS`, chain id.                                                           |
| `ingest:once` exits 1                                                                           | Same                                                                                  | The scheduler and release gate read this exit code; do not treat it as an empty run.                                                                       |
| Ingestion stops early, watermark unchanged                                                      | A block's canonical hash was unavailable                                              | Logged with the block number. Resume happens automatically once the RPC can answer for that height.                                                        |
| All entries blocked with "Chain canonicality is unproven"                                       | Provider not configured, or entries predate identity capture                          | Confirm `RPC_URL`/`CHAIN_ID`, then let ingestion replay to backfill identity.                                                                              |
| An entry is `ORPHANED`                                                                          | The chain contradicted it                                                             | Freeze the affected batch, preserve the evidence row, and follow `treasury-revenue-close.md` for the correction decision.                                  |
| Sweep action returns 409 `SweepEligibilityBlocked`                                              | An allocated entry is not eligible or not canonical                                   | Read `details.entries`. Before execution, void or rebuild the batch without the entry. After execution, hold close and follow `treasury-revenue-close.md`. |
| Mark executed returns 409 `ExecutionMatchFailed` naming the finalized head or a missing receipt | The claim transaction is not yet final, or the indexer read it from an orphaned block | Wait for finality and retry; a missing or re-mined receipt is a reorganization and needs the correction decision.                                          |

## Verification

```bash
pnpm --filter treasury run test          # unit + contract tests
pnpm --filter treasury run typecheck
pnpm --filter treasury run lint

# The reorganization drill and the append-only evidence guarantees are
# database-level; they need a real PostgreSQL instance.
TREASURY_POSTGRES_TESTS=true DB_HOST=127.0.0.1 DB_PORT=5432 \
  pnpm --filter treasury run test

# The manifest fingerprint must match the schema the migration produces.
node --test shared-db/schema-fingerprint.manifests.postgres.test.js
```

## Scope boundary

`treasury_claim_events` rows still do not carry a block hash or a stored
canonicality verdict. Before a claim is matched to a sweep batch, its receipt is
re-read from the settlement RPC and must be successful at the reported block, at
or below the finalized head. The claim's log content is not re-derived: the
batch amount and payout receiver are matched against the indexed claim, and a
reorganization that preserved the transaction but changed its logs is outside
this check.

## Residual risk

Finality on Base is an L2 property derived from L1. A finality violation would
defeat the ingestion bound, which is why the bound is paired with re-verification
rather than trusted alone — but a reorganization deeper than the finalized head
would still require an operator-led correction, not an automatic one.

External provider and bank completion remains outside Cotsel authority and
requires independently verifiable evidence.
