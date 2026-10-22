-- Durable critical notifications (SOW H-26): an alert is committed here before
-- delivery, retried with backoff, dead-lettered when its attempts are spent,
-- and escalated to the duty owner when a critical one cannot be delivered.
-- Additive: the running image does not read this table, so it can be applied
-- before the image that does.
SET LOCAL lock_timeout = '5s';

CREATE TABLE notification_outbox (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    event JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    occurrences INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    dead_lettered_at TIMESTAMPTZ,
    escalation_attempts INTEGER NOT NULL DEFAULT 0,
    escalation_next_attempt_at TIMESTAMPTZ,
    escalation_last_error TEXT,
    escalation_reason TEXT,
    escalated_at TIMESTAMPTZ,
    redriven_from BIGINT REFERENCES notification_outbox(id),
    CONSTRAINT notification_outbox_severity CHECK (severity IN ('info', 'warning', 'critical')),
    CONSTRAINT notification_outbox_state CHECK (state IN ('PENDING', 'DELIVERED', 'DEAD_LETTER')),
    CONSTRAINT notification_outbox_delivered_shape CHECK ((state = 'DELIVERED') = (delivered_at IS NOT NULL)),
    CONSTRAINT notification_outbox_dead_letter_shape CHECK ((state = 'DEAD_LETTER') = (dead_lettered_at IS NOT NULL)),
    CONSTRAINT notification_outbox_escalation_reason CHECK (
        escalation_reason IS NULL OR escalation_reason IN ('DEAD_LETTER', 'DELIVERY_OVERDUE')
    ),
    CONSTRAINT notification_outbox_escalated_shape CHECK ((escalated_at IS NULL) = (escalation_reason IS NULL)),
    CONSTRAINT notification_outbox_counts CHECK (occurrences >= 1 AND attempts >= 0 AND escalation_attempts >= 0)
);

-- One open notification per incident: a repeat raises its occurrence count.
CREATE UNIQUE INDEX notification_outbox_one_pending_per_dedup_key
    ON notification_outbox(dedup_key) WHERE state = 'PENDING';
CREATE INDEX notification_outbox_due
    ON notification_outbox(next_attempt_at) WHERE state = 'PENDING';
CREATE INDEX notification_outbox_recent_delivery
    ON notification_outbox(dedup_key, delivered_at) WHERE state = 'DELIVERED';
CREATE INDEX notification_outbox_awaiting_escalation
    ON notification_outbox(created_at)
    WHERE severity = 'critical' AND escalated_at IS NULL AND state <> 'DELIVERED';

-- Delivered and dead-lettered rows are evidence. They never return to PENDING
-- and their payload cannot change; a dead letter is redriven as a new row that
-- names it in `redriven_from`.
CREATE FUNCTION protect_notification_outbox_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF OLD.state <> 'PENDING' AND (
        NEW.state IS DISTINCT FROM OLD.state
        OR NEW.event IS DISTINCT FROM OLD.event
        OR NEW.attempts IS DISTINCT FROM OLD.attempts
        OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
        OR NEW.dead_lettered_at IS DISTINCT FROM OLD.dead_lettered_at
    ) THEN
        RAISE EXCEPTION 'notification_outbox_settled_row_is_immutable';
    END IF;
    IF OLD.escalated_at IS NOT NULL AND (
        NEW.escalated_at IS DISTINCT FROM OLD.escalated_at
        OR NEW.escalation_reason IS DISTINCT FROM OLD.escalation_reason
    ) THEN
        RAISE EXCEPTION 'notification_outbox_escalation_is_immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER notification_outbox_evidence_guard BEFORE UPDATE ON notification_outbox
FOR EACH ROW EXECUTE FUNCTION protect_notification_outbox_evidence();

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE notification_outbox TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE notification_outbox_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_outbox_service_isolation ON notification_outbox;
CREATE POLICY notification_outbox_service_isolation ON notification_outbox
    FOR ALL
    USING (current_app_service_name() = 'oracle')
    WITH CHECK (current_app_service_name() = 'oracle');
