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
        'pending_approvals',
        'approved',
        'executed',
        'cancelled',
        'expired',
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

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idempotency_completed_at ON idempotency_keys(completed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_audit_log_request_id ON audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_route_created_at ON audit_log(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_status_created_at ON audit_log(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_created_at ON governance_actions(created_at DESC, action_id DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_category_status_created_at ON governance_actions(category, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_trade_id_created_at ON governance_actions(trade_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_trade_id_decided_at ON compliance_decisions(trade_id, decided_at DESC, decision_id DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_result_decided_at ON compliance_decisions(result, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_reason_code_decided_at ON compliance_decisions(reason_code, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_progression_blocks_state_updated_at ON oracle_progression_blocks(block_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_progression_blocks_latest_decision_id ON oracle_progression_blocks(latest_decision_id);
