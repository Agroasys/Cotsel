CREATE TABLE IF NOT EXISTS reconcile_runs (
    id SERIAL PRIMARY KEY,
    run_key VARCHAR(255) NOT NULL UNIQUE,
    mode VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,
    total_trades INT NOT NULL DEFAULT 0,
    drift_count INT NOT NULL DEFAULT 0,
    critical_count INT NOT NULL DEFAULT 0,
    high_count INT NOT NULL DEFAULT 0,
    medium_count INT NOT NULL DEFAULT 0,
    low_count INT NOT NULL DEFAULT 0,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS reconcile_drifts (
    id SERIAL PRIMARY KEY,
    run_id INT NOT NULL REFERENCES reconcile_runs(id) ON DELETE CASCADE,
    run_key VARCHAR(255) NOT NULL,
    trade_id VARCHAR(255) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    mismatch_code VARCHAR(64) NOT NULL,
    compared_field VARCHAR(64) NOT NULL DEFAULT 'general',
    onchain_value TEXT,
    indexed_value TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurrences INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_run_trade_mismatch_field UNIQUE (run_key, trade_id, mismatch_code, compared_field)
);

CREATE TABLE IF NOT EXISTS reconcile_run_trades (
    id SERIAL PRIMARY KEY,
    run_id INT NOT NULL REFERENCES reconcile_runs(id) ON DELETE CASCADE,
    run_key VARCHAR(255) NOT NULL REFERENCES reconcile_runs(run_key) ON DELETE CASCADE,
    trade_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_reconcile_run_trade UNIQUE (run_key, trade_id)
);

ALTER TABLE reconcile_drifts
ADD COLUMN IF NOT EXISTS compared_field VARCHAR(64) NOT NULL DEFAULT 'general';

UPDATE reconcile_drifts
SET compared_field = COALESCE(NULLIF(details->>'field', ''), compared_field)
WHERE compared_field = 'general';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_run_trade_mismatch') THEN
        ALTER TABLE reconcile_drifts DROP CONSTRAINT uq_run_trade_mismatch;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_run_trade_mismatch_field') THEN
        ALTER TABLE reconcile_drifts
        ADD CONSTRAINT uq_run_trade_mismatch_field UNIQUE (run_key, trade_id, mismatch_code, compared_field);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reconcile_runs_status ON reconcile_runs(status);
CREATE INDEX IF NOT EXISTS idx_reconcile_runs_started_at ON reconcile_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconcile_drifts_trade_id ON reconcile_drifts(trade_id);
CREATE INDEX IF NOT EXISTS idx_reconcile_drifts_severity ON reconcile_drifts(severity);
CREATE INDEX IF NOT EXISTS idx_reconcile_drifts_mismatch ON reconcile_drifts(mismatch_code);
CREATE INDEX IF NOT EXISTS idx_reconcile_drifts_compared_field ON reconcile_drifts(compared_field);
CREATE INDEX IF NOT EXISTS idx_reconcile_run_trades_run_key ON reconcile_run_trades(run_key);
CREATE INDEX IF NOT EXISTS idx_reconcile_run_trades_trade_id ON reconcile_run_trades(trade_id);

CREATE OR REPLACE FUNCTION current_app_service_name()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(current_setting('app.service_name', true), '');
$$;

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;

    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_runs TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_drifts TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_run_trades TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE reconcile_runs_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE reconcile_drifts_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE reconcile_run_trades_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE reconcile_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_runs_service_isolation ON reconcile_runs;
CREATE POLICY reconcile_runs_service_isolation ON reconcile_runs
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');

ALTER TABLE reconcile_drifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_drifts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_drifts_service_isolation ON reconcile_drifts;
CREATE POLICY reconcile_drifts_service_isolation ON reconcile_drifts
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');

ALTER TABLE reconcile_run_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_run_trades FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_run_trades_service_isolation ON reconcile_run_trades;
CREATE POLICY reconcile_run_trades_service_isolation ON reconcile_run_trades
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');
