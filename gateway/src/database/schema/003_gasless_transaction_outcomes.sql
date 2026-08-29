ALTER TABLE idempotency_keys
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP;

UPDATE idempotency_keys
SET lease_expires_at = created_at + INTERVAL '5 minutes'
WHERE completed_at IS NULL
  AND lease_expires_at IS NULL;

ALTER TABLE settlement_handoffs
    DROP CONSTRAINT IF EXISTS settlement_handoffs_execution_status_check;
ALTER TABLE settlement_handoffs
    ADD CONSTRAINT settlement_handoffs_execution_status_check
    CHECK (execution_status IN (
        'pending',
        'accepted',
        'queued',
        'broadcast_unknown',
        'confirmation_pending',
        'submitted',
        'confirmed',
        'reverted',
        'replaced',
        'failed',
        'rejected'
    ));

ALTER TABLE settlement_execution_events
    DROP CONSTRAINT IF EXISTS settlement_execution_events_execution_status_check;
ALTER TABLE settlement_execution_events
    ADD CONSTRAINT settlement_execution_events_execution_status_check
    CHECK (execution_status IN (
        'pending',
        'accepted',
        'queued',
        'broadcast_unknown',
        'confirmation_pending',
        'submitted',
        'confirmed',
        'reverted',
        'replaced',
        'failed',
        'rejected'
    ));

ALTER TABLE settlement_execution_events
    DROP CONSTRAINT IF EXISTS settlement_execution_events_event_type_check;
ALTER TABLE settlement_execution_events
    ADD CONSTRAINT settlement_execution_events_event_type_check
    CHECK (event_type IN (
        'accepted',
        'queued',
        'simulation_completed',
        'broadcast_unknown',
        'confirmation_pending',
        'submitted',
        'confirmed',
        'reverted',
        'replaced',
        'failed',
        'rejected',
        'reconciled',
        'cancelled'
    ));

CREATE TABLE IF NOT EXISTS gasless_transaction_outcomes (
    transaction_hash VARCHAR(66) PRIMARY KEY
        CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    application_request_id TEXT NOT NULL,
    resource_type VARCHAR(32) NOT NULL
        CHECK (resource_type IN ('settlement_handoff', 'platform_transfer')),
    resource_id TEXT NOT NULL,
    operation VARCHAR(64) NOT NULL,
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    signer_address VARCHAR(42) NOT NULL
        CHECK (signer_address ~ '^0x[0-9A-Fa-f]{40}$'),
    transaction_nonce BIGINT NOT NULL CHECK (transaction_nonce >= 0),
    transaction_type SMALLINT NOT NULL CHECK (transaction_type IN (0, 2)),
    destination_address VARCHAR(42) NOT NULL
        CHECK (destination_address ~ '^0x[0-9A-Fa-f]{40}$'),
    value_wei NUMERIC(78, 0) NOT NULL CHECK (value_wei >= 0),
    gas_limit NUMERIC(78, 0) NOT NULL CHECK (gas_limit > 0),
    max_fee_per_gas_wei NUMERIC(78, 0),
    max_priority_fee_per_gas_wei NUMERIC(78, 0),
    gas_price_wei NUMERIC(78, 0),
    calldata_hash VARCHAR(66) NOT NULL CHECK (calldata_hash ~ '^0x[0-9a-f]{64}$'),
    intent_hash VARCHAR(66) NOT NULL CHECK (intent_hash ~ '^0x[0-9a-f]{64}$'),
    outcome_status VARCHAR(32) NOT NULL CHECK (outcome_status IN (
        'broadcast_pending',
        'broadcast_unknown',
        'confirmation_pending',
        'confirmed',
        'reverted',
        'replaced',
        'failed'
    )),
    projected_outcome_status VARCHAR(32) CHECK (projected_outcome_status IS NULL OR
        projected_outcome_status IN (
            'broadcast_pending',
            'broadcast_unknown',
            'confirmation_pending',
            'confirmed',
            'reverted',
            'replaced',
            'failed'
        )
    ),
    failure_code VARCHAR(128),
    block_number BIGINT,
    block_hash VARCHAR(66) CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
    gas_used NUMERIC(78, 0),
    effective_gas_price_wei NUMERIC(78, 0),
    last_reconciliation_attempt_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (application_request_id, operation, resource_type, resource_id),
    CHECK (
        (transaction_type = 0 AND gas_price_wei IS NOT NULL)
        OR (transaction_type = 2 AND max_fee_per_gas_wei IS NOT NULL)
    )
);

ALTER TABLE gasless_transaction_outcomes
    ADD COLUMN IF NOT EXISTS last_reconciliation_attempt_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS gasless_transaction_outcome_events (
    outcome_event_id BIGSERIAL PRIMARY KEY,
    transaction_hash VARCHAR(66) NOT NULL
        REFERENCES gasless_transaction_outcomes(transaction_hash) ON DELETE RESTRICT,
    outcome_status VARCHAR(32) NOT NULL CHECK (outcome_status IN (
        'broadcast_pending',
        'broadcast_unknown',
        'confirmation_pending',
        'confirmed',
        'reverted',
        'replaced',
        'failed'
    )),
    failure_code VARCHAR(128),
    block_number BIGINT,
    block_hash VARCHAR(66) CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gasless_transaction_outcomes_unresolved
    ON gasless_transaction_outcomes(
        outcome_status,
        COALESCE(last_reconciliation_attempt_at, created_at)
    )
    WHERE outcome_status IN ('broadcast_pending', 'broadcast_unknown', 'confirmation_pending');
CREATE INDEX IF NOT EXISTS idx_gasless_transaction_outcomes_resource
    ON gasless_transaction_outcomes(resource_type, resource_id, created_at DESC);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE gasless_transaction_outcomes TO %I',
            runtime_user
        );
        EXECUTE format(
            'GRANT SELECT, INSERT ON TABLE gasless_transaction_outcome_events TO %I',
            runtime_user
        );
        EXECUTE format(
            'GRANT USAGE, SELECT ON SEQUENCE gasless_transaction_outcome_events_outcome_event_id_seq TO %I',
            runtime_user
        );
    END IF;
END
$$;

ALTER TABLE gasless_transaction_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gasless_transaction_outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gasless_transaction_outcomes_service_isolation
    ON gasless_transaction_outcomes;
CREATE POLICY gasless_transaction_outcomes_service_isolation
    ON gasless_transaction_outcomes
    FOR ALL
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');

ALTER TABLE gasless_transaction_outcome_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gasless_transaction_outcome_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gasless_transaction_outcome_events_service_isolation
    ON gasless_transaction_outcome_events;
CREATE POLICY gasless_transaction_outcome_events_service_isolation
    ON gasless_transaction_outcome_events
    FOR ALL
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');
