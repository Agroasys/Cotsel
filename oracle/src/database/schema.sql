CREATE TABLE IF NOT EXISTS oracle_triggers (
    id SERIAL,
    
    action_key VARCHAR(255) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    idempotency_key VARCHAR(255) PRIMARY KEY,
    
    trade_id VARCHAR(100) NOT NULL,
    trigger_type VARCHAR(50) NOT NULL,
    request_hash VARCHAR(66),
    
    attempt_count INT DEFAULT 0,
    status VARCHAR(30) NOT NULL,
    
    tx_hash VARCHAR(66),
    block_number BIGINT,
    confirmation_stage VARCHAR(16),
    confirmation_stage_at TIMESTAMP,
    
    indexer_confirmed BOOLEAN DEFAULT false,
    indexer_confirmed_at TIMESTAMP,
    indexer_event_id VARCHAR(255),
    
    last_error TEXT,
    error_type VARCHAR(50),
    
    on_chain_verified BOOLEAN DEFAULT false,
    on_chain_verified_at TIMESTAMP,

    approved_by VARCHAR(255),
    approved_at TIMESTAMP,
    rejected_by VARCHAR(255),
    rejected_at TIMESTAMP,
    rejection_reason TEXT,
    
    created_at TIMESTAMP DEFAULT NOW(),
    submitted_at TIMESTAMP,
    confirmed_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_key ON oracle_triggers(action_key);
CREATE INDEX IF NOT EXISTS idx_trade_id ON oracle_triggers(trade_id);
CREATE INDEX IF NOT EXISTS idx_status ON oracle_triggers(status);
CREATE INDEX IF NOT EXISTS idx_created_at ON oracle_triggers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_id ON oracle_triggers(request_id);

CREATE INDEX IF NOT EXISTS idx_submitted_unconfirmed 
ON oracle_triggers(status, submitted_at) 
WHERE status = 'SUBMITTED' AND indexer_confirmed = false;

CREATE INDEX IF NOT EXISTS idx_exhausted_needs_redrive 
ON oracle_triggers(status, updated_at) 
WHERE status = 'EXHAUSTED_NEEDS_REDRIVE';

CREATE INDEX IF NOT EXISTS idx_pending_approval
ON oracle_triggers(status, created_at)
WHERE status = 'PENDING_APPROVAL';

CREATE TABLE IF NOT EXISTS oracle_hmac_nonces (
    api_key VARCHAR(128) NOT NULL,
    nonce VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (api_key, nonce)
);

CREATE INDEX IF NOT EXISTS idx_oracle_hmac_nonces_expires_at
ON oracle_hmac_nonces(expires_at);


DO $$
BEGIN
    ALTER TABLE oracle_triggers ADD COLUMN IF NOT EXISTS confirmation_stage   VARCHAR(16);
    ALTER TABLE oracle_triggers ADD COLUMN IF NOT EXISTS confirmation_stage_at TIMESTAMP;
    ALTER TABLE oracle_triggers ADD COLUMN IF NOT EXISTS approved_by      VARCHAR(255);
    ALTER TABLE oracle_triggers ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMP;
    ALTER TABLE oracle_triggers ADD COLUMN IF NOT EXISTS rejected_by      VARCHAR(255);
    ALTER TABLE oracle_triggers ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMP;
    ALTER TABLE oracle_triggers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

    ALTER TABLE oracle_triggers DROP CONSTRAINT IF EXISTS check_status;
    ALTER TABLE oracle_triggers ADD CONSTRAINT check_status
        CHECK (status IN (
            'PENDING',
            'EXECUTING',
            'SUBMITTED',
            'CONFIRMED',
            'FAILED',
            'EXHAUSTED_NEEDS_REDRIVE',
            'TERMINAL_FAILURE',
            'PENDING_APPROVAL',
            'REJECTED'
        ));


    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_trigger_type') THEN
        ALTER TABLE oracle_triggers ADD CONSTRAINT check_trigger_type
            CHECK (trigger_type IN ('RELEASE_STAGE_1', 'CONFIRM_ARRIVAL', 'FINALIZE_TRADE'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_error_type') THEN
        ALTER TABLE oracle_triggers ADD CONSTRAINT check_error_type
            CHECK (error_type IN ('VALIDATION', 'NETWORK', 'CONTRACT', 'TERMINAL', 'INDEXER_LAG'));
    END IF;

    ALTER TABLE oracle_triggers DROP CONSTRAINT IF EXISTS check_confirmation_stage;
    ALTER TABLE oracle_triggers ADD CONSTRAINT check_confirmation_stage
        CHECK (confirmation_stage IS NULL OR confirmation_stage IN ('INDEXED', 'SAFE', 'FINALIZED'));

END $$;


DROP INDEX IF EXISTS idx_active_action_key_unique;
CREATE UNIQUE INDEX idx_active_action_key_unique
    ON oracle_triggers(action_key)
    WHERE status IN ('PENDING', 'EXECUTING', 'SUBMITTED', 'PENDING_APPROVAL');
