-- WP-3 / H-17, PRES-11: reconciliation run leases and scoped discrepancy containment.
--
-- H-17 adds the lease a RUNNING run must hold to keep working, so a crashed
-- worker's run expires instead of wedging its run key forever, and exactly one
-- successor can take it over without direct SQL repair.
--
-- PRES-11 adds the per-trade containment record a qualified discrepancy opens,
-- so the affected trade is blocked — and only that trade — behind a traceable
-- incident reference until a fresh reconciliation and a governed approval
-- release it. The containment row is also the fail-closed gate the oracle reads
-- before it submits any progression for a trade, so a contained trade cannot
-- progress in the window between the incident and an operator applying the
-- on-chain scoped pause.

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
    -- When the escrow's own scoped pause was last read as applied to this
    -- trade, and at which block. The containment blocks the oracle from the
    -- moment it is written; this records when the on-chain half caught up, and
    -- a containment that has never been seen paused cannot be released.
    pause_observed_at TIMESTAMP,
    pause_observed_block BIGINT,
    pause_last_checked_at TIMESTAMP,
    -- Set by the first clean reconciliation observed *after* the incident was
    -- opened. A clean read from a run that predates the incident proves nothing.
    cleared_run_key VARCHAR(255),
    cleared_at TIMESTAMP,
    -- The governed on-chain unpause that authorises resumption, recorded from
    -- its own transaction receipt rather than as an operator-supplied string.
    -- Reconciliation never writes these from a comparison result.
    approval_tx_hash VARCHAR(66),
    approval_chain_id BIGINT,
    approval_contract VARCHAR(42),
    approval_block_number BIGINT,
    approval_block_hash VARCHAR(66),
    approval_log_index INT,
    -- The bytes32 incident reference carried by the executed on-chain proposal,
    -- which must resolve to this row's incident_reference.
    approval_incident_ref VARCHAR(66),
    approval_approvers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    approval_count INT,
    approval_required INT,
    approved_at TIMESTAMP,
    released_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_reconcile_trade_containments_state
        CHECK (state IN ('CONTAINED', 'RECONCILED_PENDING_APPROVAL', 'RELEASED')),
    -- A release must carry its on-chain evidence, and a RELEASED row must have
    -- been observed paused first: releasing a trade that was never paused would
    -- be recording a recovery from a containment the chain never enforced.
    CONSTRAINT ck_reconcile_trade_containments_release_evidence
        CHECK (
            state <> 'RELEASED'
            OR (
                approval_tx_hash IS NOT NULL
                AND approval_chain_id IS NOT NULL
                AND approval_contract IS NOT NULL
                AND approval_block_number IS NOT NULL
                AND approval_log_index IS NOT NULL
                AND approval_incident_ref IS NOT NULL
                AND pause_observed_at IS NOT NULL
            )
        )
);

-- Every governed unpause receipt that has ever released a containment.
--
-- Kept apart from the containment row because a containment can reopen, and
-- reopening clears the approval that released the previous incident — so the
-- row itself cannot remember what has been spent. Here the record is permanent,
-- which is what makes one receipt release exactly one containment: presenting
-- it for another trade, or again for the same trade after a later divergence,
-- collides with the primary key.
CREATE TABLE IF NOT EXISTS reconcile_spent_unpause_approvals (
    tx_hash VARCHAR(66) PRIMARY KEY,
    trade_id VARCHAR(255) NOT NULL,
    incident_reference VARCHAR(64) NOT NULL,
    chain_id BIGINT NOT NULL,
    block_number BIGINT NOT NULL,
    log_index INT NOT NULL,
    spent_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Alerts a run commits alongside its findings, dispatched only once the
-- transaction that produced them has landed.
--
-- A run that sends an alert as it finds something has already told an operator
-- about evidence it may yet be fenced out of publishing. Enqueuing here and
-- dispatching after commit makes every alert describe committed state. The row
-- survives a crash between commit and dispatch, so the alert is delivered late
-- rather than lost, and `dispatched_at` is what keeps it from being sent twice.
CREATE TABLE IF NOT EXISTS reconcile_alert_outbox (
    id BIGSERIAL PRIMARY KEY,
    run_id INT NOT NULL REFERENCES reconcile_runs(id) ON DELETE CASCADE,
    run_key VARCHAR(255) NOT NULL,
    kind VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    dispatched_at TIMESTAMP,
    dispatch_attempts INT NOT NULL DEFAULT 0,
    last_error TEXT
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
-- The oracle's progression guard looks a single trade up on every submission,
-- so this lookup sits in the settlement hot path.
CREATE INDEX IF NOT EXISTS idx_reconcile_trade_containments_blocking
    ON reconcile_trade_containments(trade_id)
    WHERE state <> 'RELEASED';
CREATE INDEX IF NOT EXISTS idx_reconcile_alert_outbox_pending
    ON reconcile_alert_outbox(id)
    WHERE dispatched_at IS NULL;

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_run_lease_events TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_trade_containments TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reconcile_alert_outbox TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT ON TABLE reconcile_spent_unpause_approvals TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE reconcile_run_lease_events_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE reconcile_trade_containments_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE reconcile_alert_outbox_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE reconcile_run_lease_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_run_lease_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_run_lease_events_service_isolation ON reconcile_run_lease_events;
CREATE POLICY reconcile_run_lease_events_service_isolation ON reconcile_run_lease_events
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');

ALTER TABLE reconcile_spent_unpause_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_spent_unpause_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_spent_unpause_approvals_service_isolation ON reconcile_spent_unpause_approvals;
CREATE POLICY reconcile_spent_unpause_approvals_service_isolation ON reconcile_spent_unpause_approvals
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');

ALTER TABLE reconcile_alert_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_alert_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconcile_alert_outbox_service_isolation ON reconcile_alert_outbox;
CREATE POLICY reconcile_alert_outbox_service_isolation ON reconcile_alert_outbox
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
