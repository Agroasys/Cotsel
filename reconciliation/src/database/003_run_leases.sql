-- WP-3 / H-17, PRES-11: reconciliation run leases and scoped discrepancy containment.
--
-- H-17 adds the lease a RUNNING run must hold to keep working, so a crashed
-- worker's run expires instead of wedging its run key forever, and exactly one
-- successor can take it over without direct SQL repair.
--
-- PRES-11 adds the per-trade containment record a qualified discrepancy opens,
-- so the affected trade is blocked — and only that trade — behind a traceable
-- incident reference until a fresh reconciliation and a governed approval
-- release it.

ALTER TABLE reconcile_runs
    ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(255),
    -- Bumped on every acquisition. A worker that lost its lease still holds the
    -- old epoch, so its writes no longer match and cannot land.
    ADD COLUMN IF NOT EXISTS lease_epoch INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lease_acquired_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS abandoned_owner VARCHAR(255),
    ADD COLUMN IF NOT EXISTS takeover_count INT NOT NULL DEFAULT 0;

-- Append-only lease history. The run row carries only the current lease, so
-- without this a second abandonment would overwrite the evidence of the first.
CREATE TABLE IF NOT EXISTS reconcile_run_lease_events (
    id SERIAL PRIMARY KEY,
    run_id INT NOT NULL REFERENCES reconcile_runs(id) ON DELETE CASCADE,
    run_key VARCHAR(255) NOT NULL,
    event VARCHAR(32) NOT NULL,
    lease_owner VARCHAR(255),
    lease_epoch INT NOT NULL DEFAULT 0,
    previous_owner VARCHAR(255),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One open containment per trade: a second qualifying discrepancy on a trade
-- already contained must fold into the standing incident rather than open a
-- competing one.
CREATE TABLE IF NOT EXISTS reconcile_trade_containments (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(255) NOT NULL UNIQUE,
    incident_reference VARCHAR(64) NOT NULL UNIQUE,
    state VARCHAR(32) NOT NULL,
    opened_run_key VARCHAR(255) NOT NULL,
    opened_at TIMESTAMP NOT NULL DEFAULT NOW(),
    qualifying_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    observation_count INT NOT NULL DEFAULT 1,
    last_observed_run_key VARCHAR(255),
    last_observed_at TIMESTAMP,
    -- Set by the first clean reconciliation observed *after* the incident was
    -- opened. A clean read from a run that predates the incident proves nothing.
    cleared_run_key VARCHAR(255),
    cleared_at TIMESTAMP,
    -- The quorum-governed approval that authorises resumption. Recorded by an
    -- operator; reconciliation never writes it from a comparison result.
    approval_reference VARCHAR(255),
    approved_at TIMESTAMP,
    released_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_reconcile_trade_containments_state
        CHECK (state IN ('CONTAINED', 'RECONCILED_PENDING_APPROVAL', 'RELEASED'))
);

CREATE INDEX IF NOT EXISTS idx_reconcile_runs_lease_expires_at
    ON reconcile_runs(lease_expires_at)
    WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS idx_reconcile_run_lease_events_run_key
    ON reconcile_run_lease_events(run_key);
CREATE INDEX IF NOT EXISTS idx_reconcile_run_lease_events_event
    ON reconcile_run_lease_events(event);
CREATE INDEX IF NOT EXISTS idx_reconcile_trade_containments_state
    ON reconcile_trade_containments(state);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_run_lease_events TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_trade_containments TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE reconcile_run_lease_events_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE reconcile_trade_containments_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE reconcile_run_lease_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_run_lease_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_run_lease_events_service_isolation ON reconcile_run_lease_events;
CREATE POLICY reconcile_run_lease_events_service_isolation ON reconcile_run_lease_events
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');

ALTER TABLE reconcile_trade_containments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_trade_containments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_trade_containments_service_isolation ON reconcile_trade_containments;
CREATE POLICY reconcile_trade_containments_service_isolation ON reconcile_trade_containments
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');
