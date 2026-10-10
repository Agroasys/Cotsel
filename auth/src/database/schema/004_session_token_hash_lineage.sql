-- SPDX-License-Identifier: Apache-2.0

-- Persist only a SHA-256 verifier of each bearer session token so a database
-- export cannot authenticate. Existing raw tokens are hashed in place, which
-- keeps live sessions valid for clients that still hold the original token.
ALTER TABLE user_sessions
    RENAME COLUMN session_id TO session_token_hash;

UPDATE user_sessions
SET session_token_hash = encode(sha256(convert_to(session_token_hash, 'UTF8')), 'hex');

-- Refresh records its predecessor. The unique parent index permits exactly one
-- successor per session, and the lineage start bounds the absolute lifetime of
-- every session descended from one login or exchange.
ALTER TABLE user_sessions
    ADD COLUMN parent_session_token_hash TEXT,
    ADD COLUMN lineage_started_at BIGINT;

UPDATE user_sessions
SET lineage_started_at = issued_at;

ALTER TABLE user_sessions
    ALTER COLUMN lineage_started_at SET NOT NULL,
    ADD CONSTRAINT user_sessions_token_hash_format
        CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT user_sessions_parent_token_hash_format
        CHECK (parent_session_token_hash IS NULL OR parent_session_token_hash ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT user_sessions_lifetime_order
        CHECK (lineage_started_at <= issued_at AND issued_at < expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_single_successor
    ON user_sessions(parent_session_token_hash)
    WHERE parent_session_token_hash IS NOT NULL;
