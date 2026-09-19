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
database enforces the same rule: `treasury_ledger_entries_canonical_requires_identity`
rejects a `CANONICAL` row without `block_hash`, `log_index` and
`canonicality_verified_at`.

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

## Applying the migration

```bash
MIGRATION_MANIFEST_PATH=treasury/dist/database/migrations.json node shared-db/migrate.js
```

**The offset cursor cannot be translated.** An offset does not identify a block,
so `next_offset` is dropped and `next_block_number` starts at 0. The next run
therefore re-reads from the start of the finalized range. This is deliberate and
safe: `entry_key` makes every ledger upsert idempotent, and the second pass is
what backfills `block_hash` and `log_index` onto rows migrated as `UNVERIFIED`.

Existing rows are **not** assumed canonical. Nothing on them supports the
stronger claim, so they stay `UNVERIFIED` — and therefore blocked — until
ingestion re-reads them and the verifier clears them. Plan the first run after
this migration to complete before an export or close is expected.

Bound the catch-up with `TREASURY_INGEST_MAX_EVENTS` if the finalized range is
large. A run stops on a whole-block boundary, never mid-block, so a partly
consumed block is re-read rather than stepped over.

## Failure handling

| Symptom                                                     | Cause                                                        | Action                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /internal/ingest` returns 503 `SettlementUnavailable` | No finalized head from the settlement RPC                    | Fail-closed by design. Restore RPC reachability; check `RPC_URL`, `RPC_FALLBACK_URLS`, chain id.                          |
| `ingest:once` exits 1                                       | Same                                                         | The scheduler and release gate read this exit code; do not treat it as an empty run.                                      |
| Ingestion stops early, watermark unchanged                  | A block's canonical hash was unavailable                     | Logged with the block number. Resume happens automatically once the RPC can answer for that height.                       |
| All entries blocked with "Chain canonicality is unproven"   | Provider not configured, or entries predate identity capture | Confirm `RPC_URL`/`CHAIN_ID`, then let ingestion replay to backfill identity.                                             |
| An entry is `ORPHANED`                                      | The chain contradicted it                                    | Freeze the affected batch, preserve the evidence row, and follow `treasury-revenue-close.md` for the correction decision. |

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

`treasury_claim_events` ingestion is bounded by the same finalized head, but
claim rows do not carry a block hash or a canonicality verdict. Claims are
matched to sweep batches for close, and extending the identity check to that
path belongs with the sweep and handoff work in
[Agroasys/Cotsel#656](https://github.com/Agroasys/Cotsel/issues/656).

## Residual risk

Finality on Base is an L2 property derived from L1. A finality violation would
defeat the ingestion bound, which is why the bound is paired with re-verification
rather than trusted alone — but a reorganization deeper than the finalized head
would still require an operator-led correction, not an automatic one.

External provider and bank completion remains outside Cotsel authority and
requires independently verifiable evidence.
