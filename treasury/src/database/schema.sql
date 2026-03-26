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
