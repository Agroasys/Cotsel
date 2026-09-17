CREATE TABLE gasless_nonce_reservations (
    reservation_id UUID PRIMARY KEY,
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    signer_address VARCHAR(42) NOT NULL
        CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
    transaction_nonce BIGINT NOT NULL CHECK (transaction_nonce >= 0),
    request_id VARCHAR(128) NOT NULL,
    application_request_id TEXT NOT NULL,
    resource_type VARCHAR(32) NOT NULL
        CHECK (resource_type IN ('settlement_handoff', 'platform_transfer')),
    resource_id TEXT NOT NULL,
    operation VARCHAR(64) NOT NULL,
    intent_hash VARCHAR(66) NOT NULL CHECK (intent_hash ~ '^0x[0-9a-f]{64}$'),
    reservation_status VARCHAR(32) NOT NULL
        CHECK (reservation_status IN ('reserved', 'signing', 'signed')),
    lease_token UUID NOT NULL,
    lease_expires_at TIMESTAMPTZ,
    recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
    signing_started_at TIMESTAMPTZ,
    signed_transaction_hash VARCHAR(66) UNIQUE
        CHECK (
            signed_transaction_hash IS NULL
            OR signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
        ),
    signed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, signer_address, transaction_nonce),
    CHECK (
        (reservation_status = 'reserved' AND lease_expires_at IS NOT NULL)
        OR (reservation_status IN ('signing', 'signed') AND lease_expires_at IS NULL)
    ),
    CHECK (
        (reservation_status = 'signed' AND signed_transaction_hash IS NOT NULL AND signed_at IS NOT NULL)
        OR (reservation_status <> 'signed' AND signed_transaction_hash IS NULL AND signed_at IS NULL)
    )
);

CREATE TABLE gasless_nonce_reservation_events (
    reservation_event_id BIGSERIAL PRIMARY KEY,
    reservation_id UUID NOT NULL
        REFERENCES gasless_nonce_reservations(reservation_id) ON DELETE RESTRICT,
    reservation_status VARCHAR(32) NOT NULL
        CHECK (reservation_status IN ('reserved', 'signing', 'signed')),
    recovery_count INTEGER NOT NULL CHECK (recovery_count >= 0),
    signed_transaction_hash VARCHAR(66)
        CHECK (
            signed_transaction_hash IS NULL
            OR signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
        ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gasless_nonce_reservations_status
    ON gasless_nonce_reservations(reservation_status, lease_expires_at, updated_at);
CREATE INDEX idx_gasless_nonce_reservations_request
    ON gasless_nonce_reservations(application_request_id, operation, resource_type, resource_id);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE gasless_nonce_reservations TO %I',
            runtime_user
        );
        EXECUTE format(
            'GRANT SELECT, INSERT ON TABLE gasless_nonce_reservation_events TO %I',
            runtime_user
        );
        EXECUTE format(
            'GRANT USAGE, SELECT ON SEQUENCE gasless_nonce_reservation_events_reservation_event_id_seq TO %I',
            runtime_user
        );
    END IF;
END
$$;
