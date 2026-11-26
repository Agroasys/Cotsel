-- SPDX-License-Identifier: Apache-2.0

-- Governed settlement template activation (Cotsel#940, review R05).
--
-- A version becomes active only through a durable preparation:
--   prepared  -> a person records the exact target (id, version, terms hash)
--                and the exact version it will replace (or none);
--   approved  -> a different person approves that exact preparation;
--   confirmed -> a person with a fresh step-up confirms it. The target and the
--                expected predecessor are re-checked under lock, and the
--                predecessor is retired and the target activated in the same
--                transaction.
-- A preparation whose predecessor or target changed is `superseded`, never
-- confirmed. Rows are permanent evidence. The settlement_templates trigger
-- below refuses any activation, or retirement of the active version, that
-- has no matching confirmed preparation, so no direct UPDATE bypasses this.
SET LOCAL lock_timeout = '5s';

CREATE TABLE settlement_template_activations (
    preparation_id TEXT PRIMARY KEY
        CHECK (preparation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    template_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    template_hash TEXT NOT NULL CHECK (template_hash ~ '^0x[0-9a-f]{64}$'),
    expected_active_version INTEGER,
    expected_active_hash TEXT
        CHECK (expected_active_hash IS NULL OR expected_active_hash ~ '^0x[0-9a-f]{64}$'),
    state TEXT NOT NULL DEFAULT 'prepared'
        CHECK (state IN ('prepared', 'approved', 'confirmed', 'superseded')),
    prepared_by TEXT NOT NULL CHECK (length(prepared_by) > 0),
    prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    prepare_request_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    approve_request_id TEXT,
    confirmed_by TEXT,
    confirmed_at TIMESTAMPTZ,
    confirm_request_id TEXT,
    superseded_at TIMESTAMPTZ,
    superseded_reason TEXT,
    FOREIGN KEY (template_id, version) REFERENCES settlement_templates (template_id, version),
    CONSTRAINT template_activations_expected_shape
        CHECK ((expected_active_version IS NULL) = (expected_active_hash IS NULL)),
    CONSTRAINT template_activations_not_self_replacing
        CHECK (expected_active_version IS NULL OR expected_active_version <> version),
    CONSTRAINT template_activations_expiry CHECK (expires_at > prepared_at),
    CONSTRAINT template_activations_approved_shape CHECK (
        (approved_by IS NULL) = (approved_at IS NULL)
        AND (approved_by IS NULL) = (approve_request_id IS NULL)
    ),
    CONSTRAINT template_activations_confirmed_shape CHECK (
        (confirmed_by IS NULL) = (confirmed_at IS NULL)
        AND (confirmed_by IS NULL) = (confirm_request_id IS NULL)
    ),
    CONSTRAINT template_activations_superseded_shape
        CHECK ((superseded_at IS NULL) = (superseded_reason IS NULL)),
    -- The two-person rule for activation: the approver never prepared it.
    CONSTRAINT template_activations_independent_approval
        CHECK (approved_by IS NULL OR approved_by <> prepared_by),
    CONSTRAINT template_activations_state_evidence CHECK (
        (state = 'prepared' AND approved_by IS NULL AND confirmed_by IS NULL AND superseded_at IS NULL)
        OR (state = 'approved' AND approved_by IS NOT NULL AND confirmed_by IS NULL AND superseded_at IS NULL)
        OR (state = 'confirmed' AND approved_by IS NOT NULL AND confirmed_by IS NOT NULL AND superseded_at IS NULL)
        OR (state = 'superseded' AND confirmed_by IS NULL AND superseded_at IS NOT NULL)
    )
);

-- A version is activated by exactly one confirmed preparation.
CREATE UNIQUE INDEX settlement_template_activations_one_confirmed
    ON settlement_template_activations (template_id, version)
    WHERE state = 'confirmed';

CREATE INDEX settlement_template_activations_open
    ON settlement_template_activations (template_id)
    WHERE state IN ('prepared', 'approved');

CREATE FUNCTION protect_settlement_template_activation() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'settlement template activations are never deleted'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'prepared' OR NEW.approved_by IS NOT NULL OR NEW.confirmed_by IS NOT NULL
            OR NEW.superseded_at IS NOT NULL
        THEN
            RAISE EXCEPTION 'a new template activation must start as prepared'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.preparation_id IS DISTINCT FROM OLD.preparation_id
        OR NEW.template_id IS DISTINCT FROM OLD.template_id
        OR NEW.version IS DISTINCT FROM OLD.version
        OR NEW.template_hash IS DISTINCT FROM OLD.template_hash
        OR NEW.expected_active_version IS DISTINCT FROM OLD.expected_active_version
        OR NEW.expected_active_hash IS DISTINCT FROM OLD.expected_active_hash
        OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by
        OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at
        OR NEW.prepare_request_id IS DISTINCT FROM OLD.prepare_request_id
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR (OLD.approved_by IS NOT NULL AND (
            NEW.approved_by IS DISTINCT FROM OLD.approved_by
            OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
            OR NEW.approve_request_id IS DISTINCT FROM OLD.approve_request_id))
        OR (OLD.confirmed_by IS NOT NULL AND (
            NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
            OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
            OR NEW.confirm_request_id IS DISTINCT FROM OLD.confirm_request_id))
        OR (OLD.superseded_at IS NOT NULL AND (
            NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
            OR NEW.superseded_reason IS DISTINCT FROM OLD.superseded_reason))
    THEN
        RAISE EXCEPTION 'template activation % is immutable evidence', OLD.preparation_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'prepared' AND NEW.state IN ('approved', 'superseded'))
        OR (OLD.state = 'approved' AND NEW.state IN ('confirmed', 'superseded'))
    ) THEN
        RAISE EXCEPTION 'template activation % cannot move from % to %',
            OLD.preparation_id, OLD.state, NEW.state
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_template_activations_protected
    BEFORE INSERT OR UPDATE OR DELETE ON settlement_template_activations
    FOR EACH ROW EXECUTE FUNCTION protect_settlement_template_activation();

-- No template becomes active, and the active one is not retired, without the
-- confirmed preparation that authorised exactly that change.
CREATE FUNCTION require_governed_template_activation() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'active' AND OLD.status <> 'active' AND NOT EXISTS (
        SELECT 1 FROM settlement_template_activations a
        WHERE a.template_id = NEW.template_id
          AND a.version = NEW.version
          AND a.template_hash = NEW.template_hash
          AND a.state = 'confirmed'
          AND a.confirmed_by = NEW.activated_by
    ) THEN
        RAISE EXCEPTION 'settlement template % v% has no confirmed activation', NEW.template_id, NEW.version
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'active' AND NEW.status = 'retired' AND NOT EXISTS (
        SELECT 1 FROM settlement_template_activations a
        WHERE a.template_id = OLD.template_id
          AND a.expected_active_version = OLD.version
          AND a.expected_active_hash = OLD.template_hash
          AND a.state = 'confirmed'
          AND a.confirmed_by = NEW.retired_by
    ) THEN
        RAISE EXCEPTION 'active settlement template % v% is retired only by a confirmed replacement',
            OLD.template_id, OLD.version
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_templates_governed_activation
    BEFORE UPDATE OF status ON settlement_templates
    FOR EACH ROW EXECUTE FUNCTION require_governed_template_activation();

-- Check the completed transaction, after confirmation, retirement and activation.
-- A confirmed row alone cannot authorize leaving the registry without active terms.
CREATE FUNCTION check_template_activation_atomicity() RETURNS trigger AS $$
BEGIN
    IF TG_TABLE_NAME = 'settlement_template_activations' THEN
        IF NEW.state <> 'confirmed' OR OLD.state = 'confirmed' THEN RETURN NEW; END IF;
        IF NOT EXISTS (
            SELECT 1 FROM settlement_templates t
            WHERE t.template_id = NEW.template_id AND t.version = NEW.version
              AND t.template_hash = NEW.template_hash AND t.status = 'active'
              AND t.activated_by = NEW.confirmed_by
        ) OR (NEW.expected_active_version IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM settlement_templates t
            WHERE t.template_id = NEW.template_id AND t.version = NEW.expected_active_version
              AND t.template_hash = NEW.expected_active_hash AND t.status = 'retired'
              AND t.retired_by = NEW.confirmed_by
        )) THEN
            RAISE EXCEPTION 'template activation must confirm and replace its predecessor atomically'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF OLD.status = 'active' AND NEW.status = 'retired' AND NOT EXISTS (
        SELECT 1 FROM settlement_template_activations a
        JOIN settlement_templates t ON t.template_id = a.template_id AND t.version = a.version
        WHERE a.template_id = OLD.template_id AND a.expected_active_version = OLD.version
          AND a.expected_active_hash = OLD.template_hash AND a.state = 'confirmed'
          AND a.confirmed_by = NEW.retired_by AND t.status = 'active'
          AND t.template_hash = a.template_hash AND t.activated_by = a.confirmed_by
    ) THEN
        RAISE EXCEPTION 'active template retirement requires its activated replacement'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER template_activation_atomic_confirmation
    AFTER UPDATE ON settlement_template_activations DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_template_activation_atomicity();
CREATE CONSTRAINT TRIGGER template_activation_atomic_retirement
    AFTER UPDATE ON settlement_templates DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_template_activation_atomicity();

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        -- No DELETE: activations are permanent evidence.
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON settlement_template_activations TO %I', runtime_user
        );
    END IF;
END
$$;

ALTER TABLE settlement_template_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_template_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY settlement_template_activations_service ON settlement_template_activations
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');
