CREATE TABLE IF NOT EXISTS managed_signer_validation_audit (
    request_id VARCHAR(128) PRIMARY KEY,
    application_request_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    operation VARCHAR(64) NOT NULL,
    intent_hash VARCHAR(66) NOT NULL CHECK (intent_hash ~ '^0x[0-9a-f]{64}$'),
    signed_transaction_hash VARCHAR(66)
        CHECK (signed_transaction_hash IS NULL OR signed_transaction_hash ~ '^0x[0-9a-f]{64}$'),
    signer_address VARCHAR(42) NOT NULL CHECK (signer_address ~ '^0x[0-9A-Fa-f]{40}$'),
    transaction_nonce BIGINT NOT NULL CHECK (transaction_nonce >= 0),
    transaction_type SMALLINT NOT NULL CHECK (transaction_type IN (0, 2)),
    outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
    failure_reason VARCHAR(64),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (
        (outcome = 'accepted' AND signed_transaction_hash IS NOT NULL AND failure_reason IS NULL)
        OR (outcome = 'rejected' AND failure_reason IS NOT NULL)
    )
);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format(
            'GRANT SELECT, INSERT ON TABLE managed_signer_validation_audit TO %I',
            runtime_user
        );
    END IF;
END
$$;

ALTER TABLE managed_signer_validation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_signer_validation_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS managed_signer_validation_audit_service_isolation
    ON managed_signer_validation_audit;
CREATE POLICY managed_signer_validation_audit_service_isolation
    ON managed_signer_validation_audit
    FOR ALL
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');

CREATE INDEX IF NOT EXISTS idx_managed_signer_validation_audit_created_at
    ON managed_signer_validation_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_managed_signer_validation_audit_application_request
    ON managed_signer_validation_audit(application_request_id, created_at DESC);
