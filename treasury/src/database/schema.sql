CREATE TABLE IF NOT EXISTS treasury_ledger_entries (
    id SERIAL PRIMARY KEY,
    entry_key VARCHAR(255) NOT NULL UNIQUE,
    trade_id VARCHAR(255) NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number INT NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    component_type VARCHAR(32) NOT NULL,
    amount_raw TEXT NOT NULL,
    source_timestamp TIMESTAMP NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payout_lifecycle_events (
    id SERIAL PRIMARY KEY,
    ledger_entry_id INT NOT NULL REFERENCES treasury_ledger_entries(id) ON DELETE CASCADE,
    state VARCHAR(32) NOT NULL,
    note TEXT,
    actor VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS treasury_ingestion_state (
    cursor_name VARCHAR(64) PRIMARY KEY,
    next_offset INT NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS treasury_auth_nonces (
    api_key VARCHAR(128) NOT NULL CHECK (length(trim(api_key)) > 0),
    nonce VARCHAR(255) NOT NULL CHECK (length(trim(nonce)) > 0),
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (api_key, nonce)
);

CREATE TABLE IF NOT EXISTS fiat_deposit_references (
    id SERIAL PRIMARY KEY,
    ramp_reference VARCHAR(255) NOT NULL UNIQUE,
    trade_id VARCHAR(255) NOT NULL,
    ledger_entry_id INT REFERENCES treasury_ledger_entries(id) ON DELETE SET NULL,
    deposit_state VARCHAR(32) NOT NULL,
    source_amount TEXT NOT NULL,
    currency VARCHAR(32) NOT NULL,
    expected_amount TEXT NOT NULL,
    expected_currency VARCHAR(32) NOT NULL,
    observed_at TIMESTAMP NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL UNIQUE,
    provider_account_ref VARCHAR(255) NOT NULL,
    failure_class VARCHAR(64),
    failure_code VARCHAR(255),
    reversal_reference VARCHAR(255),
    latest_event_payload_hash CHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fiat_deposit_events (
    id SERIAL PRIMARY KEY,
    fiat_deposit_reference_id INT NOT NULL REFERENCES fiat_deposit_references(id) ON DELETE CASCADE,
    ramp_reference VARCHAR(255) NOT NULL,
    trade_id VARCHAR(255) NOT NULL,
    ledger_entry_id INT REFERENCES treasury_ledger_entries(id) ON DELETE SET NULL,
    deposit_state VARCHAR(32) NOT NULL,
    source_amount TEXT NOT NULL,
    currency VARCHAR(32) NOT NULL,
    expected_amount TEXT NOT NULL,
    expected_currency VARCHAR(32) NOT NULL,
    observed_at TIMESTAMP NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL UNIQUE,
    provider_account_ref VARCHAR(255) NOT NULL,
    failure_class VARCHAR(64),
    failure_code VARCHAR(255),
    reversal_reference VARCHAR(255),
    payload_hash CHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_payout_confirmations (
    id SERIAL PRIMARY KEY,
    ledger_entry_id INT NOT NULL REFERENCES treasury_ledger_entries(id) ON DELETE CASCADE,
    payout_reference VARCHAR(255),
    bank_reference VARCHAR(255) NOT NULL UNIQUE,
    bank_state VARCHAR(32) NOT NULL,
    confirmed_at TIMESTAMP NOT NULL,
    source VARCHAR(255) NOT NULL,
    actor VARCHAR(255) NOT NULL,
    failure_code VARCHAR(255),
    evidence_reference VARCHAR(255),
    payload_hash CHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS treasury_partner_handoffs (
    id SERIAL PRIMARY KEY,
    ledger_entry_id INT NOT NULL UNIQUE REFERENCES treasury_ledger_entries(id) ON DELETE CASCADE,
    partner_code VARCHAR(32) NOT NULL,
    handoff_reference VARCHAR(255) NOT NULL UNIQUE,
    partner_status VARCHAR(32) NOT NULL,
    payout_reference VARCHAR(255),
    transfer_reference VARCHAR(255),
    drain_reference VARCHAR(255),
    destination_external_account_id VARCHAR(255),
    liquidation_address_id VARCHAR(255),
    source_amount TEXT,
    source_currency VARCHAR(32),
    destination_amount TEXT,
    destination_currency VARCHAR(32),
    actor VARCHAR(255) NOT NULL,
    note TEXT,
    failure_code VARCHAR(255),
    latest_event_payload_hash CHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    initiated_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS treasury_partner_handoff_events (
    id SERIAL PRIMARY KEY,
    partner_handoff_id INT NOT NULL REFERENCES treasury_partner_handoffs(id) ON DELETE CASCADE,
    ledger_entry_id INT NOT NULL REFERENCES treasury_ledger_entries(id) ON DELETE CASCADE,
    partner_code VARCHAR(32) NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL UNIQUE,
    event_type VARCHAR(64) NOT NULL,
    partner_status VARCHAR(32) NOT NULL,
    payout_reference VARCHAR(255),
    transfer_reference VARCHAR(255),
    drain_reference VARCHAR(255),
    destination_external_account_id VARCHAR(255),
    liquidation_address_id VARCHAR(255),
    bank_reference VARCHAR(255),
    bank_state VARCHAR(32),
    evidence_reference VARCHAR(255),
    failure_code VARCHAR(255),
    payload_hash CHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO treasury_ingestion_state (cursor_name, next_offset)
VALUES ('trade_events', 0)
ON CONFLICT (cursor_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_treasury_ledger_trade_id ON treasury_ledger_entries(trade_id);
CREATE INDEX IF NOT EXISTS idx_treasury_ledger_created_at ON treasury_ledger_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_payout_state_created ON payout_lifecycle_events(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_payout_entry_created ON payout_lifecycle_events(ledger_entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_auth_nonces_expires_at ON treasury_auth_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_treasury_auth_nonces_key_expiry ON treasury_auth_nonces(api_key, nonce, expires_at);
CREATE INDEX IF NOT EXISTS idx_fiat_deposit_trade_observed ON fiat_deposit_references(trade_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fiat_deposit_ledger_observed ON fiat_deposit_references(ledger_entry_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fiat_deposit_state_observed ON fiat_deposit_references(deposit_state, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fiat_deposit_event_reference_created ON fiat_deposit_events(fiat_deposit_reference_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_payout_confirmation_ledger_confirmed ON bank_payout_confirmations(ledger_entry_id, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_partner_handoff_ledger_updated ON treasury_partner_handoffs(ledger_entry_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_partner_handoff_status_updated ON treasury_partner_handoffs(partner_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_partner_handoff_event_ledger_created ON treasury_partner_handoff_events(ledger_entry_id, created_at DESC);

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
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE treasury_ledger_entries TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payout_lifecycle_events TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE treasury_ingestion_state TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE treasury_auth_nonces TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fiat_deposit_references TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fiat_deposit_events TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bank_payout_confirmations TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE treasury_partner_handoffs TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE treasury_partner_handoff_events TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE treasury_ledger_entries_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE payout_lifecycle_events_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE fiat_deposit_references_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE fiat_deposit_events_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE bank_payout_confirmations_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE treasury_partner_handoffs_id_seq TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE treasury_partner_handoff_events_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE treasury_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_ledger_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_ledger_entries_service_isolation ON treasury_ledger_entries;
CREATE POLICY treasury_ledger_entries_service_isolation ON treasury_ledger_entries
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE payout_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_lifecycle_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payout_lifecycle_events_service_isolation ON payout_lifecycle_events;
CREATE POLICY payout_lifecycle_events_service_isolation ON payout_lifecycle_events
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE treasury_ingestion_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_ingestion_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_ingestion_state_service_isolation ON treasury_ingestion_state;
CREATE POLICY treasury_ingestion_state_service_isolation ON treasury_ingestion_state
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE treasury_auth_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_auth_nonces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_auth_nonces_service_isolation ON treasury_auth_nonces;
CREATE POLICY treasury_auth_nonces_service_isolation ON treasury_auth_nonces
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE fiat_deposit_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiat_deposit_references FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiat_deposit_references_service_isolation ON fiat_deposit_references;
CREATE POLICY fiat_deposit_references_service_isolation ON fiat_deposit_references
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE fiat_deposit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiat_deposit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiat_deposit_events_service_isolation ON fiat_deposit_events;
CREATE POLICY fiat_deposit_events_service_isolation ON fiat_deposit_events
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE bank_payout_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_payout_confirmations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_payout_confirmations_service_isolation ON bank_payout_confirmations;
CREATE POLICY bank_payout_confirmations_service_isolation ON bank_payout_confirmations
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE treasury_partner_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_partner_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_partner_handoffs_service_isolation ON treasury_partner_handoffs;
CREATE POLICY treasury_partner_handoffs_service_isolation ON treasury_partner_handoffs
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

ALTER TABLE treasury_partner_handoff_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_partner_handoff_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_partner_handoff_events_service_isolation ON treasury_partner_handoff_events;
CREATE POLICY treasury_partner_handoff_events_service_isolation ON treasury_partner_handoff_events
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');
