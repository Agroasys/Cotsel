-- SPDX-License-Identifier: Apache-2.0

-- Record the authentication assurance a trusted session exchange asserts
-- (Cotsel#946): when and how the operator last authenticated upstream. The
-- gateway uses it to require a recent step-up for privileged actions. Refresh
-- copies the parent's values, so a successor never looks more recently
-- authenticated than the exchange that started its lineage. Existing sessions
-- keep NULLs and are treated as not freshly authenticated.
ALTER TABLE user_sessions
    ADD COLUMN auth_time BIGINT,
    ADD COLUMN auth_method TEXT,
    ADD COLUMN auth_strength TEXT;

ALTER TABLE user_sessions
    ADD CONSTRAINT user_sessions_auth_method_known
        CHECK (auth_method IS NULL OR auth_method IN ('password', 'webauthn', 'recovery_code', 'auth0')),
    ADD CONSTRAINT user_sessions_auth_strength_known
        CHECK (
            auth_strength IS NULL
            OR auth_strength IN (
                'password', 'webauthn', 'hardware_webauthn', 'recovery_code', 'auth0_mfa', 'unverified'
            )
        ),
    ADD CONSTRAINT user_sessions_auth_time_before_issue
        CHECK (auth_time IS NULL OR (auth_time > 0 AND auth_time <= issued_at + 60));
