CREATE TABLE IF NOT EXISTS gasless_commands (
    command_id TEXT PRIMARY KEY,
    application_request_id TEXT NOT NULL UNIQUE,
    intent_key VARCHAR(64) NOT NULL UNIQUE CHECK (intent_key ~ '^[0-9a-f]{64}$'),
    resource_type TEXT NOT NULL CHECK (resource_type IN ('settlement_handoff', 'platform_transfer')),
    resource_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'pending',
        'leased',
        'outcome_pending',
        'completed',
        'failed',
        'dead_letter'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    transaction_hash VARCHAR(66)
        CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
    result JSONB,
    last_error_code TEXT,
    last_error_detail TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK (status = 'leased' OR lease_owner IS NULL),
    CHECK (status <> 'outcome_pending' OR transaction_hash IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS gasless_command_attempts (
    attempt_id BIGSERIAL PRIMARY KEY,
    command_id TEXT NOT NULL REFERENCES gasless_commands(command_id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    lease_owner TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    outcome TEXT CHECK (outcome IN (
        'completed',
        'retry_scheduled',
        'lease_expired',
        'outcome_pending',
        'outcome_resolved',
        'dead_letter'
    )),
    transaction_hash VARCHAR(66)
        CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
    error_code TEXT,
    error_detail TEXT,
    UNIQUE (command_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS gasless_commands_due_idx
    ON gasless_commands (next_attempt_at, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS gasless_commands_expired_lease_idx
    ON gasless_commands (lease_expires_at)
    WHERE status = 'leased';

CREATE INDEX IF NOT EXISTS gasless_commands_status_updated_idx
    ON gasless_commands (status, updated_at);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE gasless_commands TO %I',
            runtime_user
        );
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE gasless_command_attempts TO %I',
            runtime_user
        );
        EXECUTE format(
            'GRANT USAGE, SELECT ON SEQUENCE gasless_command_attempts_attempt_id_seq TO %I',
            runtime_user
        );
    END IF;
END
$$;

ALTER TABLE gasless_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE gasless_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gasless_commands_service_isolation ON gasless_commands;
CREATE POLICY gasless_commands_service_isolation ON gasless_commands
    FOR ALL
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');

ALTER TABLE gasless_command_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gasless_command_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gasless_command_attempts_service_isolation ON gasless_command_attempts;
CREATE POLICY gasless_command_attempts_service_isolation ON gasless_command_attempts
    FOR ALL
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');
