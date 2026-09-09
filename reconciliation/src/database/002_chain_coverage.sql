-- WP-3 / B-07, FAIL-05, FAIL-07: chain-derived bidirectional coverage.
--
-- Adds the persisted keyset cursor a run resumes from, and the complete-range
-- accounting a finished run must publish so a truncated sweep can no longer be
-- mistaken for a clean one.

CREATE TABLE IF NOT EXISTS reconcile_cursors (
    scope VARCHAR(64) PRIMARY KEY,
    last_trade_id NUMERIC(78, 0) NOT NULL DEFAULT 0,
    boundary_block_number BIGINT NOT NULL DEFAULT 0,
    boundary_block_hash VARCHAR(66) NOT NULL DEFAULT '',
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_reconcile_cursors_trade_id_non_negative CHECK (last_trade_id >= 0)
);

ALTER TABLE reconcile_runs
    ADD COLUMN IF NOT EXISTS coverage_from_trade_id NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS coverage_to_trade_id NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS coverage_from_block BIGINT,
    ADD COLUMN IF NOT EXISTS coverage_to_block BIGINT,
    ADD COLUMN IF NOT EXISTS chain_trade_counter NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS next_cursor NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS uncovered_tail NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS coverage_complete BOOLEAN;

-- The tail's first sighting drives the age SLA: a tail that has not shrunk
-- within the SLA means the sweep can no longer keep up.
ALTER TABLE reconcile_cursors
    ADD COLUMN IF NOT EXISTS tail_first_seen_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_reconcile_runs_coverage_complete
    ON reconcile_runs(coverage_complete);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_cursors TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE reconcile_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_cursors_service_isolation ON reconcile_cursors;
CREATE POLICY reconcile_cursors_service_isolation ON reconcile_cursors
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');
