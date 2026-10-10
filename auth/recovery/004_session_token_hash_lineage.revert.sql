-- SPDX-License-Identifier: Apache-2.0

-- Reviewed recovery for migration 202610100004 (session_token_hash_lineage).
-- Not a migration: it is never listed in migrations.json and never runs from an
-- application image. Use it only under docs/runbooks/auth-session-token-hash-cutover.md,
-- when the previous auth image must run again after 202610100004 was applied.
--
-- Hashing is one-way, so no session survives: user_sessions is recreated empty
-- in its 202609130003 shape (fail closed) and users re-establish sessions
-- through the trusted exchange. Profiles, nonces, admin audit, and signer
-- bindings are untouched. The table is rebuilt rather than altered so column
-- positions, and therefore the pinned schema fingerprints, match both the
-- previous manifest and a later re-application of 202610100004.
--
-- Run as the auth migration role. The single DO block applies atomically.

DO $$
DECLARE
    head_version TEXT;
    grant_statements TEXT[];
    grant_statement TEXT;
BEGIN
    SELECT max(version) INTO head_version
    FROM cotsel_schema_migrations
    WHERE service_name = 'auth';
    IF head_version IS DISTINCT FROM '202610100004' THEN
        RAISE EXCEPTION 'auth migration head is %, expected 202610100004', head_version;
    END IF;

    -- Carry the runtime role's table grants across the rebuild.
    SELECT array_agg(format('GRANT %s ON TABLE user_sessions TO %I', acl.privilege_type, role_row.rolname))
    INTO grant_statements
    FROM pg_class class_row
    CROSS JOIN LATERAL aclexplode(class_row.relacl) AS acl
    JOIN pg_roles role_row ON role_row.oid = acl.grantee
    WHERE class_row.oid = 'public.user_sessions'::regclass
      AND acl.grantee <> class_row.relowner;

    DROP TABLE user_sessions;

    CREATE TABLE user_sessions (
        session_id    TEXT PRIMARY KEY,
        user_id       UUID NOT NULL REFERENCES user_profiles(id),
        wallet_address TEXT,
        role          TEXT NOT NULL,
        issued_at     BIGINT NOT NULL,
        expires_at    BIGINT NOT NULL,
        revoked_at    BIGINT
    );
    CREATE INDEX idx_user_sessions_user_id    ON user_sessions(user_id);
    CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
    CREATE INDEX idx_user_sessions_active
        ON user_sessions(session_id, expires_at)
        WHERE revoked_at IS NULL;

    ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY user_sessions_service_isolation ON user_sessions
        FOR ALL
        USING (current_app_service_name() = 'auth')
        WITH CHECK (current_app_service_name() = 'auth');

    FOREACH grant_statement IN ARRAY coalesce(grant_statements, ARRAY[]::TEXT[]) LOOP
        EXECUTE grant_statement;
    END LOOP;

    DELETE FROM cotsel_schema_migrations
    WHERE service_name = 'auth'
      AND version = '202610100004';
END
$$;
