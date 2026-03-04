-- SPDX-License-Identifier: Apache-2.0

CREATE TABLE IF NOT EXISTS user_profiles (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT NOT NULL UNIQUE,
    role          TEXT NOT NULL CHECK (role IN ('buyer', 'supplier', 'admin', 'oracle')),
    org_id        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_wallet ON user_profiles(wallet_address);
CREATE INDEX IF NOT EXISTS idx_user_profiles_org    ON user_profiles(org_id);

CREATE TABLE IF NOT EXISTS user_sessions (
    session_id    TEXT PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES user_profiles(id),
    wallet_address TEXT NOT NULL,
    role          TEXT NOT NULL,
    issued_at     BIGINT NOT NULL,
    expires_at    BIGINT NOT NULL,
    revoked_at    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id    ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active
    ON user_sessions(session_id, expires_at)
    WHERE revoked_at IS NULL;

