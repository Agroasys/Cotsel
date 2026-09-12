-- SPDX-License-Identifier: Apache-2.0

-- Explicit, environment-scoped hardware-wallet authority. The auth runtime may
-- read and administer these records, but never receives wallet key material.
CREATE TABLE IF NOT EXISTS operator_signer_bindings (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id           TEXT NOT NULL REFERENCES user_profiles(account_id),
    wallet_address       TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    action_class         TEXT NOT NULL CHECK (action_class IN (
        'governance',
        'treasury_approve',
        'treasury_execute',
        'treasury_close',
        'compliance_sensitive',
        'emergency_admin'
    )),
    environment          TEXT NOT NULL CHECK (
        environment <> '*'
        AND environment ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    ),
    custodian_name       TEXT NOT NULL CHECK (length(btrim(custodian_name)) BETWEEN 2 AND 200),
    approving_authority  TEXT NOT NULL CHECK (length(btrim(approving_authority)) BETWEEN 2 AND 200),
    approved_at          TIMESTAMPTZ NOT NULL,
    approval_ticket      TEXT NOT NULL CHECK (length(btrim(approval_ticket)) BETWEEN 2 AND 200),
    notes                TEXT,
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_by           TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at           TIMESTAMPTZ,
    revoked_by           TEXT,
    revoked_reason       TEXT,
    CONSTRAINT operator_signer_binding_revocation_complete CHECK (
        (active = TRUE AND revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
        OR
        (active = FALSE AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL)
    ),
    CONSTRAINT operator_signer_binding_approval_not_future CHECK (
        approved_at <= created_at
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_signer_bindings_active_wallet_scope
    ON operator_signer_bindings(wallet_address, action_class, environment)
    WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_operator_signer_bindings_account_active
    ON operator_signer_bindings(account_id, action_class, environment)
    WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_operator_signer_bindings_approval_ticket
    ON operator_signer_bindings(approval_ticket);

CREATE OR REPLACE FUNCTION prevent_operator_signer_binding_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.active = FALSE THEN
        RAISE EXCEPTION 'revoked operator signer bindings are immutable';
    END IF;

    IF OLD.account_id IS DISTINCT FROM NEW.account_id
       OR OLD.wallet_address IS DISTINCT FROM NEW.wallet_address
       OR OLD.action_class IS DISTINCT FROM NEW.action_class
       OR OLD.environment IS DISTINCT FROM NEW.environment
       OR OLD.custodian_name IS DISTINCT FROM NEW.custodian_name
       OR OLD.approving_authority IS DISTINCT FROM NEW.approving_authority
       OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
       OR OLD.approval_ticket IS DISTINCT FROM NEW.approval_ticket
       OR OLD.notes IS DISTINCT FROM NEW.notes
       OR OLD.created_by IS DISTINCT FROM NEW.created_by
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'operator signer approval evidence is immutable';
    END IF;

    IF NEW.active = TRUE AND (
        NEW.revoked_at IS NOT NULL
        OR NEW.revoked_by IS NOT NULL
        OR NEW.revoked_reason IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'active operator signer binding cannot contain revocation evidence';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operator_signer_binding_evidence_immutable
    ON operator_signer_bindings;
CREATE TRIGGER operator_signer_binding_evidence_immutable
    BEFORE UPDATE ON operator_signer_bindings
    FOR EACH ROW
    EXECUTE FUNCTION prevent_operator_signer_binding_evidence_mutation();

CREATE OR REPLACE FUNCTION revoke_signer_bindings_without_admin_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (OLD.role = 'admin' AND NEW.role <> 'admin')
       OR (OLD.active = TRUE AND NEW.active = FALSE) THEN
        UPDATE operator_signer_bindings
        SET active = FALSE,
            revoked_at = NOW(),
            revoked_by = 'auth:profile-authority-trigger',
            revoked_reason = 'profile_authority_removed',
            updated_at = NOW()
        WHERE account_id = NEW.account_id
          AND active = TRUE;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS revoke_signer_bindings_on_profile_authority_change
    ON user_profiles;
CREATE TRIGGER revoke_signer_bindings_on_profile_authority_change
    AFTER UPDATE OF role, active ON user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION revoke_signer_bindings_without_admin_authority();

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    REVOKE ALL ON TABLE operator_signer_bindings FROM PUBLIC;
    IF runtime_user IS NOT NULL THEN
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE operator_signer_bindings TO %I',
            runtime_user
        );
    END IF;
END $$;

ALTER TABLE operator_signer_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_signer_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_signer_bindings_service_isolation ON operator_signer_bindings;
CREATE POLICY operator_signer_bindings_service_isolation ON operator_signer_bindings
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');
