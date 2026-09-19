-- WP-4 B-09 / FAIL-10: ingestion freshness and single-owner run evidence.
--
-- Ingestion had no owner and no proof of life. `treasury_ingestion_state` said
-- where the last run had reached, but nothing said *when* it reached there, so
-- a stopped ingester was indistinguishable from an ingester that had caught up
-- and found nothing. Every health signal treasury published stayed green while
-- the fee evidence behind export, realization and close went arbitrarily stale.
--
-- Two things are added. A freshness watermark on the cursor -- when a run last
-- succeeded, what it was blocked by, how many attempts have failed in a row --
-- which readiness and export eligibility read and fail closed against. And an
-- append-only run log, so a stopped-ingestion drill leaves evidence that names
-- the owner, the window it proved, and the reason it stopped.

ALTER TABLE treasury_ingestion_state
    ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS last_blocked_reason TEXT,
    ADD COLUMN IF NOT EXISTS consecutive_failure_count INT NOT NULL DEFAULT 0
        CHECK (consecutive_failure_count >= 0),
    ADD COLUMN IF NOT EXISTS last_partial_reason TEXT;

-- Deliberately left NULL for rows that already exist. `updated_at` is not a
-- substitute: it moves on every run including a refused one, so adopting it
-- here would assert freshness that no run ever proved. NULL means "no run has
-- proved this cursor fresh", which readiness and export both treat as stale.
-- The first completed run of the new worker sets it.
COMMENT ON COLUMN treasury_ingestion_state.last_success_at IS
    'When a run last read the whole bounded window without a blocked reason. A run capped part-way advances coverage but not this column, because freshness is a claim about having caught up. NULL means no run has proved this cursor fresh; readiness and export eligibility fail closed until one does.';
COMMENT ON COLUMN treasury_ingestion_state.last_attempt_at IS
    'When a run last started against this cursor, whether or not it completed. Compared with last_success_at to separate "not running" from "running and refusing".';
COMMENT ON COLUMN treasury_ingestion_state.last_blocked_reason IS
    'Why the most recent run refused to ingest, cleared on the next completed run. Carries the operator-facing cause into readiness output.';
COMMENT ON COLUMN treasury_ingestion_state.consecutive_failure_count IS
    'Attempts since the last completed run. Drives the lag alarm before the freshness threshold is reached.';

CREATE TABLE IF NOT EXISTS treasury_ingestion_runs (
    id SERIAL PRIMARY KEY,
    run_key UUID NOT NULL UNIQUE,
    worker_identity VARCHAR(255) NOT NULL CHECK (length(trim(worker_identity)) > 0),
    trigger_source VARCHAR(32) NOT NULL
        CHECK (trigger_source IN ('WORKER', 'CLI', 'API')),
    outcome VARCHAR(32) NOT NULL
        CHECK (outcome IN ('COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'NOT_OWNER')),
    fetched INT NOT NULL DEFAULT 0 CHECK (fetched >= 0),
    inserted INT NOT NULL DEFAULT 0 CHECK (inserted >= 0),
    stable_block_number INT CHECK (stable_block_number >= 0),
    indexer_processed_block_number INT CHECK (indexer_processed_block_number >= 0),
    ingested_through_block_number INT CHECK (ingested_through_block_number >= 0),
    next_trade_block_number INT CHECK (next_trade_block_number >= 0),
    next_claim_block_number INT CHECK (next_claim_block_number >= 0),
    blocked_reason TEXT,
    duration_ms INT NOT NULL CHECK (duration_ms >= 0),
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- A run that read something proved a window, whether or not it reached the
    -- end of it. A run that refused or threw proved nothing, and storing a
    -- coverage height beside it would let a reader reconstruct a range nothing
    -- actually read.
    CONSTRAINT treasury_ingestion_runs_outcome_consistent CHECK (
        (outcome = 'COMPLETED' AND blocked_reason IS NULL)
        OR outcome = 'PARTIAL'
        OR (outcome NOT IN ('COMPLETED', 'PARTIAL') AND ingested_through_block_number IS NULL)
    )
);

COMMENT ON TABLE treasury_ingestion_runs IS
    'Append-only record of every ingestion attempt: its owner, the window it proved, and why it stopped. One row is written per attempt, at the end, so a run that never returns leaves a freshness gap rather than a misleading in-progress row.';
COMMENT ON COLUMN treasury_ingestion_runs.trigger_source IS
    'WORKER for the scheduled single-owner loop, CLI for --ingest-once, API for the internal ingest route. Separates routine coverage from operator-driven backfill in the evidence bundle.';
COMMENT ON COLUMN treasury_ingestion_runs.outcome IS
    'NOT_OWNER records a worker tick that declined because another replica held the lease; it proves the schedule is alive without claiming coverage. PARTIAL records a run that read successfully but stopped short of the bounded window, so it advanced coverage without proving freshness.';

CREATE OR REPLACE FUNCTION treasury_ingestion_runs_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'treasury_ingestion_runs is append-only; % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS treasury_ingestion_runs_immutable ON treasury_ingestion_runs;
CREATE TRIGGER treasury_ingestion_runs_immutable
    BEFORE UPDATE OR DELETE ON treasury_ingestion_runs
    FOR EACH ROW
    EXECUTE FUNCTION treasury_ingestion_runs_append_only();

CREATE INDEX IF NOT EXISTS idx_treasury_ingestion_runs_completed_at
    ON treasury_ingestion_runs(completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_ingestion_runs_outcome_completed_at
    ON treasury_ingestion_runs(outcome, completed_at DESC);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE treasury_ingestion_runs TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE treasury_ingestion_runs_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE treasury_ingestion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_ingestion_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_ingestion_runs_service_isolation ON treasury_ingestion_runs;
CREATE POLICY treasury_ingestion_runs_service_isolation ON treasury_ingestion_runs
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');
