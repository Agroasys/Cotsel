CREATE TABLE IF NOT EXISTS ricardian_hashes (
    id SERIAL PRIMARY KEY,
    request_id VARCHAR(100) NOT NULL,
    document_ref TEXT NOT NULL,
    hash CHAR(64) NOT NULL,
    rules_version VARCHAR(64) NOT NULL,
    canonical_json TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ricardian_hash_doc UNIQUE (hash, document_ref)
);

CREATE TABLE IF NOT EXISTS ricardian_auth_nonces (
    api_key VARCHAR(128) NOT NULL CHECK (length(trim(api_key)) > 0),
    nonce VARCHAR(255) NOT NULL CHECK (length(trim(nonce)) > 0),
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (api_key, nonce)
);

CREATE INDEX IF NOT EXISTS idx_ricardian_hash ON ricardian_hashes(hash);
CREATE INDEX IF NOT EXISTS idx_ricardian_document_ref ON ricardian_hashes(document_ref);
CREATE INDEX IF NOT EXISTS idx_ricardian_created_at ON ricardian_hashes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ricardian_auth_nonces_expires_at ON ricardian_auth_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_ricardian_auth_nonces_key_expiry ON ricardian_auth_nonces(api_key, nonce, expires_at);

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
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ricardian_hashes TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ricardian_auth_nonces TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE ricardian_hashes_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE ricardian_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ricardian_hashes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ricardian_hashes_service_isolation ON ricardian_hashes;
CREATE POLICY ricardian_hashes_service_isolation ON ricardian_hashes
    FOR ALL
    USING (current_app_service_name() = 'ricardian')
    WITH CHECK (current_app_service_name() = 'ricardian');

ALTER TABLE ricardian_auth_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE ricardian_auth_nonces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ricardian_auth_nonces_service_isolation ON ricardian_auth_nonces;
CREATE POLICY ricardian_auth_nonces_service_isolation ON ricardian_auth_nonces
    FOR ALL
    USING (current_app_service_name() = 'ricardian')
    WITH CHECK (current_app_service_name() = 'ricardian');
