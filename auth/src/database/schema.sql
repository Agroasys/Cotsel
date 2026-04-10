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
