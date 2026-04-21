-- SPDX-License-Identifier: Apache-2.0

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS user_profiles (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    TEXT UNIQUE,
    wallet_address TEXT UNIQUE,
    email         TEXT,
    role          TEXT NOT NULL CHECK (role IN ('buyer', 'supplier', 'admin', 'oracle')),
    org_id        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active        BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_role TEXT CHECK (break_glass_role IS NULL OR break_glass_role = 'admin');
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_expires_at TIMESTAMPTZ;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_granted_at TIMESTAMPTZ;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_granted_by TEXT;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_reason TEXT;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_revoked_at TIMESTAMPTZ;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_revoked_by TEXT;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_reviewed_at TIMESTAMPTZ;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS break_glass_reviewed_by TEXT;
ALTER TABLE user_profiles
    ALTER COLUMN wallet_address DROP NOT NULL;
UPDATE user_profiles
SET account_id = id::text
WHERE account_id IS NULL;
ALTER TABLE user_profiles
    ALTER COLUMN account_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_account_id
    ON user_profiles(account_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_wallet ON user_profiles(wallet_address);
CREATE INDEX IF NOT EXISTS idx_user_profiles_email  ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_profiles_org    ON user_profiles(org_id);

CREATE TABLE IF NOT EXISTS user_sessions (
    session_id    TEXT PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES user_profiles(id),
    wallet_address TEXT,
    role          TEXT NOT NULL,
    issued_at     BIGINT NOT NULL,
    expires_at    BIGINT NOT NULL,
    revoked_at    BIGINT
);

ALTER TABLE user_sessions
    ALTER COLUMN wallet_address DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id    ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active
    ON user_sessions(session_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS trusted_session_exchange_nonces (
    api_key    TEXT NOT NULL,
    nonce      TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (api_key, nonce)
);

CREATE TABLE IF NOT EXISTS auth_admin_control_nonces (
    api_key    TEXT NOT NULL,
    nonce      TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (api_key, nonce)
);

CREATE TABLE IF NOT EXISTS auth_admin_audit_events (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id             TEXT NOT NULL,
    target_user_id          UUID,
    action                 TEXT NOT NULL CHECK (action IN (
        'profile_provisioned',
        'profile_role_updated',
        'profile_deactivated',
        'break_glass_granted',
        'break_glass_revoked',
        'break_glass_expired',
        'break_glass_reviewed'
    )),
    actor_type             TEXT NOT NULL CHECK (actor_type IN ('service_auth', 'system')),
    actor_id               TEXT NOT NULL,
    previous_role          TEXT,
    new_role               TEXT,
    reason                 TEXT NOT NULL,
    break_glass_expires_at TIMESTAMPTZ,
    metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE auth_admin_audit_events
    DROP CONSTRAINT IF EXISTS auth_admin_audit_events_action_check;
ALTER TABLE auth_admin_audit_events
    ADD CONSTRAINT auth_admin_audit_events_action_check CHECK (action IN (
        'profile_provisioned',
        'profile_role_updated',
        'profile_deactivated',
        'break_glass_granted',
        'break_glass_revoked',
        'break_glass_expired',
        'break_glass_reviewed',
        'operator_capabilities_updated',
        'signer_binding_provisioned',
        'signer_binding_revoked'
    ));

CREATE TABLE IF NOT EXISTS operator_capability_bindings (
    account_id    TEXT NOT NULL REFERENCES user_profiles(account_id) ON DELETE CASCADE,
    capability    TEXT NOT NULL CHECK (capability IN (
        'governance:write',
        'compliance:write',
        'treasury:read',
        'treasury:prepare',
        'treasury:approve',
        'treasury:execute_match',
        'treasury:close'
    )),
    granted_by    TEXT NOT NULL,
    grant_reason  TEXT NOT NULL,
    ticket_ref    TEXT,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_operator_capability_bindings_account
    ON operator_capability_bindings(account_id);

CREATE TABLE IF NOT EXISTS operator_signer_bindings (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id         TEXT NOT NULL REFERENCES user_profiles(account_id) ON DELETE CASCADE,
    wallet_address     TEXT NOT NULL,
    action_class       TEXT NOT NULL CHECK (action_class IN (
        'governance',
        'treasury_approve',
        'treasury_execute',
        'treasury_close',
        'compliance_sensitive',
        'emergency_admin'
    )),
    environment        TEXT NOT NULL,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    provisioned_by     TEXT NOT NULL,
    provision_reason   TEXT NOT NULL,
    provision_ticket_ref TEXT,
    notes              TEXT,
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at         TIMESTAMPTZ,
    revoked_by         TEXT,
    revoked_reason     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_signer_bindings_active_unique
    ON operator_signer_bindings(account_id, wallet_address, action_class, environment)
    WHERE active = TRUE AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_operator_signer_bindings_account
    ON operator_signer_bindings(account_id);
CREATE INDEX IF NOT EXISTS idx_operator_signer_bindings_wallet_env
    ON operator_signer_bindings(wallet_address, environment)
    WHERE active = TRUE AND revoked_at IS NULL;

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
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_profiles TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_sessions TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE trusted_session_exchange_nonces TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_admin_control_nonces TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT ON TABLE auth_admin_audit_events TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE operator_capability_bindings TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE operator_signer_bindings TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_profiles_service_isolation ON user_profiles;
CREATE POLICY user_profiles_service_isolation ON user_profiles
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_sessions_service_isolation ON user_sessions;
CREATE POLICY user_sessions_service_isolation ON user_sessions
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');

ALTER TABLE trusted_session_exchange_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE trusted_session_exchange_nonces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trusted_session_exchange_nonces_service_isolation ON trusted_session_exchange_nonces;
CREATE POLICY trusted_session_exchange_nonces_service_isolation ON trusted_session_exchange_nonces
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');

ALTER TABLE auth_admin_control_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_admin_control_nonces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_admin_control_nonces_service_isolation ON auth_admin_control_nonces;
CREATE POLICY auth_admin_control_nonces_service_isolation ON auth_admin_control_nonces
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');

ALTER TABLE auth_admin_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_admin_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_admin_audit_events_service_isolation ON auth_admin_audit_events;
CREATE POLICY auth_admin_audit_events_service_isolation ON auth_admin_audit_events
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');

ALTER TABLE operator_capability_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_capability_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_capability_bindings_service_isolation ON operator_capability_bindings;
CREATE POLICY operator_capability_bindings_service_isolation ON operator_capability_bindings
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');

ALTER TABLE operator_signer_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_signer_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_signer_bindings_service_isolation ON operator_signer_bindings;
CREATE POLICY operator_signer_bindings_service_isolation ON operator_signer_bindings
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');

CREATE INDEX IF NOT EXISTS idx_auth_admin_audit_events_account_created
    ON auth_admin_audit_events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_admin_audit_events_action_created
    ON auth_admin_audit_events(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_break_glass_expiry
    ON user_profiles(break_glass_expires_at)
    WHERE break_glass_role = 'admin' AND break_glass_revoked_at IS NULL;
