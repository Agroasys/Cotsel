-- WP-4 B-08 / FAIL-06: block-hash canonicality for treasury chain evidence.
--
-- A ledger entry recorded only `block_number`, and eligibility was decided by
-- comparing that number against the finalized head. Height is not identity: an
-- orphaned block keeps its number, so an entry ingested from a block that later
-- lost the canonical chain stayed permanently eligible, and there was nothing
-- stored that could ever contradict it. Payout and external handoff could then
-- be built on an event the chain no longer contains.
--
-- These columns give an entry the identity height cannot supply -- the block
-- hash and the log index the event was read at -- plus a canonicality state
-- that is re-derived from the settlement RPC before export or handoff. The
-- state is an axis of its own rather than another payout lifecycle state:
-- revoking orphan eligibility must hold even for an entry whose lifecycle has
-- already reached a terminal state and can no longer transition.

CREATE DOMAIN treasury_block_hash AS TEXT
    CONSTRAINT treasury_block_hash_is_canonical CHECK (VALUE ~ '^0x[0-9a-f]{64}$');

COMMENT ON DOMAIN treasury_block_hash IS
    'A 32-byte block hash in lowercase 0x-prefixed hex, canonical spelling only.';

ALTER TABLE treasury_ledger_entries
    ADD COLUMN IF NOT EXISTS block_hash treasury_block_hash,
    ADD COLUMN IF NOT EXISTS log_index INT CHECK (log_index >= 0),
    ADD COLUMN IF NOT EXISTS canonicality_state VARCHAR(16) NOT NULL DEFAULT 'UNVERIFIED'
        CHECK (canonicality_state IN ('UNVERIFIED', 'CANONICAL', 'ORPHANED')),
    ADD COLUMN IF NOT EXISTS canonicality_verified_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS canonicality_observed_block_hash treasury_block_hash,
    ADD COLUMN IF NOT EXISTS canonicality_depth INT,
    ADD COLUMN IF NOT EXISTS canonicality_stable_block_number INT
        CHECK (canonicality_stable_block_number >= 0),
    ADD COLUMN IF NOT EXISTS log_address VARCHAR(42)
        CHECK (log_address ~ '^0x[0-9a-f]{40}$'),
    ADD COLUMN IF NOT EXISTS log_identity_hash CHAR(64)
        CHECK (log_identity_hash ~ '^[0-9a-f]{64}$');

-- Existing rows keep the default UNVERIFIED rather than being assumed
-- canonical. They were ingested without a block hash, so nothing on the row
-- supports the stronger claim; ingestion re-reads them from its rewound
-- watermark and upgrades each one it can prove.
COMMENT ON COLUMN treasury_ledger_entries.block_hash IS
    'Canonical block hash the settlement RPC reported for block_number at ingestion. NULL means the entry predates canonicality capture.';
COMMENT ON COLUMN treasury_ledger_entries.log_index IS
    'Exact log position within the block, re-checked against the transaction receipt before export or handoff.';
COMMENT ON COLUMN treasury_ledger_entries.log_address IS
    'Contract that emitted the ingested log. A position alone does not identify an event; a different contract at the same index is a different event.';
COMMENT ON COLUMN treasury_ledger_entries.log_identity_hash IS
    'SHA-256 over the emitter, topics and data of the ingested log. Re-derived from the receipt before export so a record pointing at a valid position with different contents cannot pass.';
COMMENT ON COLUMN treasury_ledger_entries.canonicality_state IS
    'CANONICAL only while a settlement-RPC re-verification matched block_hash and the log identity. ORPHANED revokes eligibility permanently until an approved correction.';
COMMENT ON COLUMN treasury_ledger_entries.canonicality_depth IS
    'Blocks between the entry block and the finalized head when a mismatch was observed, recorded as reorganization depth evidence.';

-- CANONICAL is a claim about one specific log in one specific block, so it
-- cannot be asserted without everything that identifies it. This closes the
-- path where a partial write, a repair session or a future migration marks an
-- entry canonical on height, on position, or on anything short of the full
-- identity the verifier actually checked.
ALTER TABLE treasury_ledger_entries
    DROP CONSTRAINT IF EXISTS treasury_ledger_entries_canonical_requires_identity;
ALTER TABLE treasury_ledger_entries
    ADD CONSTRAINT treasury_ledger_entries_canonical_requires_identity CHECK (
        canonicality_state <> 'CANONICAL'
        OR (
            block_hash IS NOT NULL
            AND log_index IS NOT NULL
            AND log_address IS NOT NULL
            AND log_identity_hash IS NOT NULL
            AND canonicality_verified_at IS NOT NULL
        )
    );

-- No index is added on `treasury_ledger_entries` here on purpose. A plain
-- CREATE INDEX holds a SHARE lock for the length of the build, which blocks
-- every INSERT and UPDATE on the ingestion and payout path, and this runner
-- executes each migration inside one transaction, so CREATE INDEX CONCURRENTLY
-- is not available to it. Nothing added by this change filters on
-- `canonicality_state`: the verifier reads entries by id, export pages on
-- `(created_at, id)`, and the operator summary is a full aggregate. An index
-- that no query needs is not worth stalling fee ingestion to build. A future
-- canonicality-filtered scan should arrive with a concurrent build in a
-- non-transactional migration step.

-- Conflicting chain evidence is preserved, never overwritten. The ledger row
-- carries the current verdict; this table carries every observation that
-- produced one, so a reorganization can be reconstructed after the fact
-- including the depth and the head it was measured against.
CREATE TABLE IF NOT EXISTS treasury_chain_reorg_events (
    id SERIAL PRIMARY KEY,
    ledger_entry_id INT NOT NULL REFERENCES treasury_ledger_entries(id) ON DELETE CASCADE,
    entry_key VARCHAR(255) NOT NULL,
    trade_id VARCHAR(255) NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number INT NOT NULL,
    expected_block_hash treasury_block_hash,
    observed_block_hash treasury_block_hash,
    observed_block_number INT,
    observed_log_index INT,
    reorg_depth INT,
    stable_block_number INT NOT NULL CHECK (stable_block_number >= 0),
    mismatch_reason VARCHAR(64) NOT NULL
        CHECK (mismatch_reason IN (
            'RECEIPT_MISSING',
            'RECEIPT_REVERTED',
            'BLOCK_HASH_MISMATCH',
            'BLOCK_NUMBER_MISMATCH',
            'LOG_IDENTITY_MISMATCH',
            'LOG_CONTENT_MISMATCH'
        )),
    detail TEXT,
    detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE treasury_chain_reorg_events IS
    'Append-only record of every observed disagreement between a stored ledger entry and the settlement chain, with the reorganization depth and the stable block it was measured at.';

CREATE OR REPLACE FUNCTION treasury_chain_reorg_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'treasury_chain_reorg_events is append-only; % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS treasury_chain_reorg_events_immutable ON treasury_chain_reorg_events;
CREATE TRIGGER treasury_chain_reorg_events_immutable
    BEFORE UPDATE OR DELETE ON treasury_chain_reorg_events
    FOR EACH ROW
    EXECUTE FUNCTION treasury_chain_reorg_events_append_only();

CREATE INDEX IF NOT EXISTS idx_treasury_chain_reorg_events_entry
    ON treasury_chain_reorg_events(ledger_entry_id, id);
CREATE INDEX IF NOT EXISTS idx_treasury_chain_reorg_events_detected_at
    ON treasury_chain_reorg_events(detected_at DESC, id DESC);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE treasury_chain_reorg_events TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE treasury_chain_reorg_events_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE treasury_chain_reorg_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_chain_reorg_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_chain_reorg_events_service_isolation ON treasury_chain_reorg_events;
CREATE POLICY treasury_chain_reorg_events_service_isolation ON treasury_chain_reorg_events
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

-- The ingestion cursor was a row offset into the indexer's result set. That
-- position only means anything while the set is append-only: when a
-- reorganization removes events below the cursor every later offset shifts
-- down, and the events that moved into the consumed range are skipped for good.
-- An offset also cannot express "up to the finalized head", which is what
-- ingestion is now bounded by.
--
-- The replacement is a chain-anchored block watermark. It cannot be derived
-- from the offset it replaces -- an offset does not identify a block -- so the
-- column is added at 0 and the next run re-reads from the start of the chain.
-- Re-reading is safe and deliberate: `entry_key` makes every ledger upsert
-- idempotent, and the second pass is what backfills the chain identity onto the
-- rows migrated above as UNVERIFIED.
--
-- This is the expand half of an expand/contract rollout. `next_offset` is kept,
-- NOT NULL and defaulted, because a deployment replaces pods one at a time: a
-- pod still running the previous image writes
-- `INSERT INTO treasury_ingestion_state (cursor_name, next_offset) ...` and
-- would fail on `column next_offset does not exist` the moment this migration
-- landed ahead of it. The two cursors coexist without interfering -- an old pod
-- advances only `next_offset`, a new pod advances only `next_block_number` --
-- and the column is dropped in a later release once no old reader remains. See
-- docs/runbooks/treasury-canonical-chain-evidence.md for the contract step.
ALTER TABLE treasury_ingestion_state
    ADD COLUMN IF NOT EXISTS next_block_number INT NOT NULL DEFAULT 0
        CHECK (next_block_number >= 0),
    ADD COLUMN IF NOT EXISTS last_ingested_through_block_number INT
        CHECK (last_ingested_through_block_number >= 0);

COMMENT ON COLUMN treasury_ingestion_state.next_block_number IS
    'Inclusive block height ingestion resumes from. Rewound to the affected height when a reorganization is detected so the canonical events there are replayed.';
COMMENT ON COLUMN treasury_ingestion_state.last_ingested_through_block_number IS
    'Height the last completed run proved coverage through: the lower of the finalized head and the indexer processed height. Not the finalized head, which the indexer may not have reached.';
COMMENT ON COLUMN treasury_ingestion_state.next_offset IS
    'Superseded by next_block_number. Retained for rolling-upgrade overlap only; no current reader writes it. Drop in the contract migration once every pod runs the block watermark.';
