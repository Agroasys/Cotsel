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
