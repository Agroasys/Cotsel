-- WP-4 B-09 / FAIL-11: append-only provider handoff state and conflict freeze.
--
-- Provider state was last-write-wins. `treasury_partner_handoffs.partner_status`
-- and `partner_handoffs.handoff_status` were overwritten by whichever callback
-- arrived most recently, with no check that the new state was reachable from
-- the old one. A delayed `PROCESSING` could regress a `COMPLETED` handoff, and
-- a `FAILED` arriving after a `COMPLETED` replaced it outright -- the record of
-- the completion simply stopped existing.
--
-- The evidence table beside it was append-only by convention only: the runtime
-- role held UPDATE and DELETE on it, and nothing in the database refused a
-- rewrite. Neither column constrained its vocabulary either, so an unmapped
-- provider string could be stored and then compared as though Cotsel knew what
-- it meant.
--
-- Three changes. The vocabulary is pinned so only states with an authoritative
-- mapping can be stored; the evidence log is made append-only in the database
-- rather than in the callers; and a contradiction -- two different terminal
-- claims about one instruction -- freezes the handoff and is preserved, instead
-- of one claim quietly replacing the other.

ALTER TABLE treasury_partner_handoffs
    DROP CONSTRAINT IF EXISTS treasury_partner_handoffs_status_vocabulary;
ALTER TABLE treasury_partner_handoffs
    ADD CONSTRAINT treasury_partner_handoffs_status_vocabulary
    CHECK (partner_status IN (
        'CREATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PROCESSING',
        'COMPLETED', 'FAILED', 'RETURNED'
    ));

ALTER TABLE treasury_partner_handoff_events
    DROP CONSTRAINT IF EXISTS treasury_partner_handoff_events_status_vocabulary;
ALTER TABLE treasury_partner_handoff_events
    ADD CONSTRAINT treasury_partner_handoff_events_status_vocabulary
    CHECK (partner_status IN (
        'CREATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PROCESSING',
        'COMPLETED', 'FAILED', 'RETURNED'
    ));

ALTER TABLE partner_handoffs
    DROP CONSTRAINT IF EXISTS partner_handoffs_status_vocabulary;
ALTER TABLE partner_handoffs
    ADD CONSTRAINT partner_handoffs_status_vocabulary
    CHECK (handoff_status IN (
        'CREATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PROCESSING',
        'COMPLETED', 'FAILED', 'RETURNED'
    ));

-- The union of the two vocabularies that had drifted apart, pinned so a
-- provider state Cotsel cannot map cannot be stored and later read as progress.
COMMENT ON COLUMN treasury_partner_handoffs.partner_status IS
    'Authoritative provider state for this ledger entry. Advanced only through a transition the append-only state machine allows; CREATED, FAILED and RETURNED never mean handed off.';
COMMENT ON COLUMN partner_handoffs.handoff_status IS
    'Authoritative provider state for this sweep batch. The batch may reach HANDED_OFF only while this is SUBMITTED, ACKNOWLEDGED, PROCESSING or COMPLETED.';

-- Freeze, not overwrite. A frozen handoff keeps the state it had when the
-- contradiction arrived; the contradicting evidence is preserved beside it.
ALTER TABLE treasury_partner_handoffs
    ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS frozen_reason TEXT;

ALTER TABLE partner_handoffs
    ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS frozen_reason TEXT;

COMMENT ON COLUMN treasury_partner_handoffs.frozen_at IS
    'Set when contradictory provider evidence arrived. While set, no provider callback may advance this handoff; only an approved correction clears it.';
COMMENT ON COLUMN partner_handoffs.frozen_at IS
    'Set when contradictory provider evidence arrived for this batch. While set, the batch cannot advance to HANDED_OFF, realization or close.';

CREATE TABLE IF NOT EXISTS treasury_partner_handoff_conflicts (
    id SERIAL PRIMARY KEY,
    record_type VARCHAR(16) NOT NULL CHECK (record_type IN ('CONFLICT', 'CORRECTION')),
    scope VARCHAR(16) NOT NULL CHECK (scope IN ('LEDGER_ENTRY', 'SWEEP_BATCH')),
    subject_id INT NOT NULL,
    partner_code VARCHAR(32) NOT NULL,
    provider_event_id VARCHAR(255),
    retained_status VARCHAR(32) NOT NULL,
    conflicting_status VARCHAR(32) NOT NULL,
    detail TEXT NOT NULL,
    actor VARCHAR(255) NOT NULL,
    resolves_conflict_id INT REFERENCES treasury_partner_handoff_conflicts(id) ON DELETE RESTRICT,
    approval_reference VARCHAR(255),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    -- A correction is an approved exception, so it must name both the conflict
    -- it resolves and the authority that approved it. A conflict names neither,
    -- because nothing has been decided yet.
    CONSTRAINT treasury_partner_handoff_conflicts_correction_is_approved CHECK (
        (record_type = 'CORRECTION'
            AND resolves_conflict_id IS NOT NULL
            AND approval_reference IS NOT NULL)
        OR (record_type = 'CONFLICT'
            AND resolves_conflict_id IS NULL
            AND approval_reference IS NULL)
    )
);

COMMENT ON TABLE treasury_partner_handoff_conflicts IS
    'Append-only record of contradictory provider evidence and the approved corrections that resolve it. A correction never edits the conflict it resolves; both rows survive, which is what makes the full history reproducible.';

-- The ledger-entry handoff had an append-only evidence log beside it; the
-- batch handoff had nothing. Its row was the only record, so a callback that
-- did not advance the authoritative state left no trace at all: a reordered
-- delivery was dropped, and a repeated one overwrote the stored evidence
-- reference on its way past. Neither an auditable record of what the provider
-- actually sent, nor an immutable record of the completion it had already sent.
CREATE TABLE IF NOT EXISTS partner_handoff_events (
    id SERIAL PRIMARY KEY,
    sweep_batch_id INT NOT NULL REFERENCES sweep_batches(id) ON DELETE CASCADE,
    partner_name VARCHAR(255) NOT NULL,
    partner_reference VARCHAR(255) NOT NULL,
    handoff_status VARCHAR(32) NOT NULL
        CHECK (handoff_status IN (
            'CREATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PROCESSING',
            'COMPLETED', 'FAILED', 'RETURNED'
        )),
    -- How the append-only state machine judged this delivery, recorded beside
    -- the delivery itself so the reason a callback did not take effect is
    -- reconstructable without replaying the classifier.
    transition VARCHAR(16) NOT NULL
        CHECK (transition IN ('ADVANCE', 'REPLAY', 'STALE', 'CONTRADICTION')),
    applied BOOLEAN NOT NULL,
    evidence_reference VARCHAR(255),
    payload_hash CHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    -- Only an ADVANCE becomes the authoritative state. Anything else is a
    -- delivery that was recorded and did not take effect.
    CONSTRAINT partner_handoff_events_applied_only_on_advance CHECK (
        applied = (transition = 'ADVANCE')
    )
);

COMMENT ON TABLE partner_handoff_events IS
    'Append-only record of every external-handoff callback for a sweep batch, written before the callback is classified. No uniqueness constraint: two identical deliveries are two deliveries, and the log records what arrived, not what was distinct.';

CREATE INDEX IF NOT EXISTS idx_partner_handoff_events_batch
    ON partner_handoff_events(sweep_batch_id, id);

CREATE OR REPLACE FUNCTION treasury_partner_handoff_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS treasury_partner_handoff_events_immutable ON treasury_partner_handoff_events;
CREATE TRIGGER treasury_partner_handoff_events_immutable
    BEFORE UPDATE OR DELETE ON treasury_partner_handoff_events
    FOR EACH ROW
    EXECUTE FUNCTION treasury_partner_handoff_append_only();

DROP TRIGGER IF EXISTS partner_handoff_events_immutable ON partner_handoff_events;
CREATE TRIGGER partner_handoff_events_immutable
    BEFORE UPDATE OR DELETE ON partner_handoff_events
    FOR EACH ROW
    EXECUTE FUNCTION treasury_partner_handoff_append_only();

DROP TRIGGER IF EXISTS treasury_partner_handoff_conflicts_immutable ON treasury_partner_handoff_conflicts;
CREATE TRIGGER treasury_partner_handoff_conflicts_immutable
    BEFORE UPDATE OR DELETE ON treasury_partner_handoff_conflicts
    FOR EACH ROW
    EXECUTE FUNCTION treasury_partner_handoff_append_only();

CREATE INDEX IF NOT EXISTS idx_treasury_partner_handoff_conflicts_subject
    ON treasury_partner_handoff_conflicts(scope, subject_id, id);
CREATE INDEX IF NOT EXISTS idx_treasury_partner_handoff_conflicts_created_at
    ON treasury_partner_handoff_conflicts(created_at DESC, id DESC);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE treasury_partner_handoff_conflicts TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT ON TABLE partner_handoff_events TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE partner_handoff_events_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE treasury_partner_handoff_conflicts_id_seq TO %I', runtime_user);
        -- The trigger already refuses a rewrite, but the grant is withdrawn as
        -- well: a control that depends only on a trigger is one `ALTER TABLE
        -- ... DISABLE TRIGGER` away from being absent.
        EXECUTE format('REVOKE UPDATE, DELETE ON TABLE treasury_partner_handoff_events FROM %I', runtime_user);
    END IF;
END $$;

ALTER TABLE partner_handoff_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_handoff_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_handoff_events_service_isolation ON partner_handoff_events;
CREATE POLICY partner_handoff_events_service_isolation ON partner_handoff_events
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE treasury_partner_handoff_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_partner_handoff_conflicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_partner_handoff_conflicts_service_isolation ON treasury_partner_handoff_conflicts;
CREATE POLICY treasury_partner_handoff_conflicts_service_isolation ON treasury_partner_handoff_conflicts
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');
