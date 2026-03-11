CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    request_method TEXT NOT NULL,
    request_path TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    request_id TEXT NOT NULL,
    response_status INTEGER,
    response_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_body JSONB,
    completed_at TIMESTAMP,
    last_replayed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    request_id TEXT NOT NULL,
    correlation_id TEXT,
    actor_user_id TEXT,
    actor_wallet_address TEXT,
    actor_role TEXT,
    status TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_actions (
    action_id TEXT PRIMARY KEY,
    intent_key TEXT,
    proposal_id BIGINT,
    category TEXT NOT NULL CHECK (category IN (
        'pause',
        'unpause',
        'claims_pause',
        'claims_unpause',
        'treasury_sweep',
        'treasury_payout_receiver_update',
        'oracle_disable_emergency',
        'oracle_update'
    )),
    status TEXT NOT NULL CHECK (status IN (
        'requested',
        'submitted',
        'pending_approvals',
        'approved',
        'executed',
        'cancelled',
        'expired',
        'stale',
        'failed'
    )),
    contract_method TEXT NOT NULL,
    tx_hash TEXT,
    extrinsic_hash TEXT,
    block_number BIGINT,
    trade_id TEXT,
    chain_id TEXT,
    target_address TEXT,
    request_id TEXT NOT NULL,
    correlation_id TEXT,
    reason TEXT NOT NULL,
    evidence_links JSONB NOT NULL DEFAULT '[]'::jsonb,
    ticket_ref TEXT NOT NULL,
    actor_session_id TEXT NOT NULL,
    actor_wallet TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    approved_by JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP,
    executed_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_decisions (
    decision_id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    decision_type TEXT NOT NULL CHECK (decision_type IN ('KYB', 'KYT', 'SANCTIONS')),
    result TEXT NOT NULL CHECK (result IN ('ALLOW', 'DENY')),
    reason_code TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    risk_level TEXT CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    correlation_id TEXT NOT NULL,
    override_window_ends_at TIMESTAMP,
    reason TEXT NOT NULL,
    evidence_links JSONB NOT NULL DEFAULT '[]'::jsonb,
    ticket_ref TEXT NOT NULL,
    actor_session_id TEXT NOT NULL,
    actor_wallet TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    approved_by JSONB NOT NULL DEFAULT '[]'::jsonb,
    decided_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS oracle_progression_blocks (
    trade_id TEXT PRIMARY KEY,
    latest_decision_id TEXT NOT NULL REFERENCES compliance_decisions(decision_id),
    block_state TEXT NOT NULL CHECK (block_state IN ('not_blocked', 'blocked', 'resume_pending')),
    reason_code TEXT NOT NULL,
    request_id TEXT NOT NULL,
    correlation_id TEXT,
    audit_reason TEXT NOT NULL,
    evidence_links JSONB NOT NULL DEFAULT '[]'::jsonb,
    ticket_ref TEXT NOT NULL,
    actor_session_id TEXT NOT NULL,
    actor_wallet TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    approved_by JSONB NOT NULL DEFAULT '[]'::jsonb,
    blocked_at TIMESTAMP,
    resumed_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_auth_nonces (
    api_key TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (api_key, nonce)
);

CREATE TABLE IF NOT EXISTS settlement_handoffs (
    handoff_id TEXT PRIMARY KEY,
    platform_id TEXT NOT NULL,
    platform_handoff_id TEXT NOT NULL,
    trade_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    settlement_channel TEXT NOT NULL,
    display_currency TEXT NOT NULL,
    display_amount NUMERIC(20, 2) NOT NULL,
    asset_symbol TEXT,
    asset_amount NUMERIC(36, 6),
    ricardian_hash TEXT,
    external_reference TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    execution_status TEXT NOT NULL CHECK (execution_status IN (
        'pending',
        'accepted',
        'queued',
        'submitted',
        'confirmed',
        'failed',
        'rejected'
    )),
    reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN (
        'pending',
        'matched',
        'drift',
        'unavailable'
    )),
    callback_status TEXT NOT NULL CHECK (callback_status IN (
        'pending',
        'delivered',
        'failed',
        'dead_letter',
        'disabled'
    )),
    provider_status TEXT,
    tx_hash TEXT,
    extrinsic_hash TEXT,
    latest_event_type TEXT,
    latest_event_detail TEXT,
    latest_event_at TIMESTAMP,
    callback_delivered_at TIMESTAMP,
    request_id TEXT NOT NULL,
    source_api_key_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (platform_id, platform_handoff_id)
);

CREATE TABLE IF NOT EXISTS settlement_execution_events (
    event_id TEXT PRIMARY KEY,
    handoff_id TEXT NOT NULL REFERENCES settlement_handoffs(handoff_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'accepted',
        'queued',
        'submitted',
        'confirmed',
        'failed',
        'rejected',
        'reconciled',
        'drift_detected'
    )),
    execution_status TEXT NOT NULL CHECK (execution_status IN (
        'pending',
        'accepted',
        'queued',
        'submitted',
        'confirmed',
        'failed',
        'rejected'
    )),
    reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN (
        'pending',
        'matched',
        'drift',
        'unavailable'
    )),
    provider_status TEXT,
    tx_hash TEXT,
    extrinsic_hash TEXT,
    detail TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMP NOT NULL,
    request_id TEXT NOT NULL,
    source_api_key_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settlement_callback_deliveries (
    delivery_id TEXT PRIMARY KEY,
    handoff_id TEXT NOT NULL REFERENCES settlement_handoffs(handoff_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES settlement_execution_events(event_id) ON DELETE CASCADE,
    target_url TEXT NOT NULL,
    request_body JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'pending',
        'delivering',
        'delivered',
        'failed',
        'dead_letter',
        'disabled'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP NOT NULL,
    last_attempted_at TIMESTAMP,
    delivered_at TIMESTAMP,
    response_status INTEGER,
    last_error TEXT,
    request_id TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE governance_actions
    ADD COLUMN IF NOT EXISTS intent_key TEXT;

ALTER TABLE governance_actions
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'governance_actions'::regclass
          AND conname = 'governance_actions_status_check'
    ) THEN
        ALTER TABLE governance_actions DROP CONSTRAINT governance_actions_status_check;
    END IF;
END $$;

ALTER TABLE governance_actions
    ADD CONSTRAINT governance_actions_status_check CHECK (status IN (
        'requested',
        'submitted',
        'pending_approvals',
        'approved',
        'executed',
        'cancelled',
        'expired',
        'stale',
        'failed'
    ));

UPDATE governance_actions
SET intent_key = CONCAT_WS('|',
        'v1',
        LOWER(COALESCE(category, '')),
        LOWER(COALESCE(contract_method, '')),
        COALESCE(proposal_id::text, ''),
        LOWER(COALESCE(target_address, '')),
        LOWER(COALESCE(trade_id, '')),
        LOWER(COALESCE(chain_id, ''))
    )
WHERE intent_key IS NULL;

UPDATE governance_actions
SET expires_at = created_at + INTERVAL '86400 seconds'
WHERE expires_at IS NULL
  AND status = 'requested';

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idempotency_completed_at ON idempotency_keys(completed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_audit_log_request_id ON audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_route_created_at ON audit_log(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_status_created_at ON audit_log(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_created_at ON governance_actions(created_at DESC, action_id DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_category_status_created_at ON governance_actions(category, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_trade_id_created_at ON governance_actions(trade_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_intent_key_status_created_at ON governance_actions(intent_key, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_requested_expires_at ON governance_actions(expires_at ASC, action_id ASC)
WHERE status = 'requested' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_trade_id_decided_at ON compliance_decisions(trade_id, decided_at DESC, decision_id DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_result_decided_at ON compliance_decisions(result, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_reason_code_decided_at ON compliance_decisions(reason_code, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_progression_blocks_state_updated_at ON oracle_progression_blocks(block_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_progression_blocks_latest_decision_id ON oracle_progression_blocks(latest_decision_id);
CREATE INDEX IF NOT EXISTS idx_service_auth_nonces_expires_at ON service_auth_nonces(expires_at ASC);
CREATE INDEX IF NOT EXISTS idx_settlement_handoffs_trade_id_updated_at ON settlement_handoffs(trade_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_handoffs_execution_status_updated_at ON settlement_handoffs(execution_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_handoffs_reconciliation_status_updated_at ON settlement_handoffs(reconciliation_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_events_handoff_observed_at ON settlement_execution_events(handoff_id, observed_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_events_event_type_created_at ON settlement_execution_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_callback_deliveries_status_next_attempt_at ON settlement_callback_deliveries(status, next_attempt_at ASC, created_at ASC);
