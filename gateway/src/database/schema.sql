CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS idempotency_keys (
    actor_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
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
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (actor_id, endpoint, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    request_id TEXT NOT NULL,
    correlation_id TEXT,
    action_id TEXT,
    idempotency_key TEXT,
    actor_id TEXT,
    actor_user_id TEXT,
    actor_wallet_address TEXT,
    actor_role TEXT,
    status TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS failed_operations (
    failed_operation_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    operation_type TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    target_service TEXT NOT NULL,
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    request_payload JSONB,
    request_id TEXT NOT NULL,
    correlation_id TEXT,
    idempotency_key TEXT,
    action_key TEXT,
    actor_id TEXT,
    actor_user_id TEXT,
    actor_wallet_address TEXT,
    actor_role TEXT,
    session_reference TEXT,
    replay_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    failure_state TEXT NOT NULL CHECK (failure_state IN (
        'open',
        'replayed',
        'replay_failed'
    )),
    first_failed_at TIMESTAMP NOT NULL,
    last_failed_at TIMESTAMP NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 1,
    terminal_error_class TEXT NOT NULL CHECK (terminal_error_class IN (
        'client_contract',
        'upstream_business',
        'infrastructure',
        'unexpected'
    )),
    terminal_error_code TEXT NOT NULL,
    terminal_error_message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_replayed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (operation_type, operation_key)
);

CREATE TABLE IF NOT EXISTS access_log_entries (
    entry_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    surface TEXT NOT NULL,
    outcome TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_wallet_address TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    session_fingerprint TEXT NOT NULL,
    session_display TEXT NOT NULL,
    ip_fingerprint TEXT,
    ip_display TEXT,
    user_agent TEXT,
    request_id TEXT NOT NULL,
    correlation_id TEXT,
    request_method TEXT NOT NULL,
    request_route TEXT NOT NULL,
    audit_references JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_assignments (
    assignment_id TEXT PRIMARY KEY,
    subject_user_id TEXT NOT NULL,
    subject_wallet_address TEXT NOT NULL,
    auth_role TEXT NOT NULL,
    gateway_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT NOT NULL,
    assigned_by_user_id TEXT,
    assigned_by_wallet_address TEXT,
    assigned_at TIMESTAMP NOT NULL,
    last_verified_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_actions (
    action_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
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
    idempotency_key TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    intent_hash TEXT NOT NULL,
    attestation_ref JSONB,
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
    decision_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
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
    idempotency_key TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    intent_hash TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS evidence_bundles (
    bundle_id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    ricardian_hash TEXT,
    generated_at TIMESTAMP NOT NULL,
    generated_by_user_id TEXT NOT NULL,
    generated_by_wallet TEXT NOT NULL,
    generated_by_role TEXT NOT NULL,
    request_id TEXT NOT NULL,
    correlation_id TEXT,
    manifest JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
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
    latest_event_id TEXT,
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
    ALTER COLUMN action_id SET DEFAULT gen_random_uuid()::text;

ALTER TABLE compliance_decisions
    ALTER COLUMN decision_id SET DEFAULT gen_random_uuid()::text;

ALTER TABLE idempotency_keys
    ADD COLUMN IF NOT EXISTS actor_id TEXT;

ALTER TABLE idempotency_keys
    ADD COLUMN IF NOT EXISTS endpoint TEXT;

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS action_id TEXT;

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS actor_id TEXT;

ALTER TABLE settlement_handoffs
    ADD COLUMN IF NOT EXISTS latest_event_id TEXT;

ALTER TABLE governance_actions
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

ALTER TABLE governance_actions
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE governance_actions
    ADD COLUMN IF NOT EXISTS actor_id TEXT;

ALTER TABLE governance_actions
    ADD COLUMN IF NOT EXISTS endpoint TEXT;

ALTER TABLE governance_actions
    ADD COLUMN IF NOT EXISTS intent_hash TEXT;

ALTER TABLE compliance_decisions
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE compliance_decisions
    ADD COLUMN IF NOT EXISTS actor_id TEXT;

ALTER TABLE compliance_decisions
    ADD COLUMN IF NOT EXISTS endpoint TEXT;

ALTER TABLE compliance_decisions
    ADD COLUMN IF NOT EXISTS intent_hash TEXT;

ALTER TABLE compliance_decisions
    ADD COLUMN IF NOT EXISTS attestation_ref JSONB;

UPDATE idempotency_keys
SET actor_id = COALESCE(NULLIF(actor_id, ''), '__legacy__'),
    endpoint = COALESCE(NULLIF(endpoint, ''), request_path)
WHERE actor_id IS NULL
   OR endpoint IS NULL
   OR actor_id = ''
   OR endpoint = '';

ALTER TABLE idempotency_keys
    ALTER COLUMN actor_id SET NOT NULL;

ALTER TABLE idempotency_keys
    ALTER COLUMN endpoint SET NOT NULL;

UPDATE governance_actions
SET actor_id = COALESCE(NULLIF(actor_id, ''), requested_by),
    endpoint = COALESCE(NULLIF(endpoint, ''), '/governance/actions'),
    idempotency_key = COALESCE(NULLIF(idempotency_key, ''), CONCAT('legacy:', action_id)),
    intent_hash = COALESCE(NULLIF(intent_hash, ''), encode(digest(COALESCE(intent_key, action_id), 'sha256'), 'hex'))
WHERE actor_id IS NULL
   OR endpoint IS NULL
   OR idempotency_key IS NULL
   OR intent_hash IS NULL
   OR actor_id = ''
   OR endpoint = ''
   OR idempotency_key = ''
   OR intent_hash = '';

ALTER TABLE governance_actions
    ALTER COLUMN actor_id SET NOT NULL;

ALTER TABLE governance_actions
    ALTER COLUMN endpoint SET NOT NULL;

ALTER TABLE governance_actions
    ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE governance_actions
    ALTER COLUMN intent_hash SET NOT NULL;

UPDATE compliance_decisions
SET actor_id = COALESCE(NULLIF(actor_id, ''), requested_by),
    endpoint = COALESCE(NULLIF(endpoint, ''), '/compliance/decisions'),
    idempotency_key = COALESCE(NULLIF(idempotency_key, ''), CONCAT('legacy:', decision_id)),
    intent_hash = COALESCE(
        NULLIF(intent_hash, ''),
        encode(digest(CONCAT_WS('|', trade_id, decision_type, result, reason_code, provider_ref, decided_at::text), 'sha256'), 'hex')
    )
WHERE actor_id IS NULL
   OR endpoint IS NULL
   OR idempotency_key IS NULL
   OR intent_hash IS NULL
   OR actor_id = ''
   OR endpoint = ''
   OR idempotency_key = ''
   OR intent_hash = '';

ALTER TABLE compliance_decisions
    ALTER COLUMN actor_id SET NOT NULL;

ALTER TABLE compliance_decisions
    ALTER COLUMN endpoint SET NOT NULL;

ALTER TABLE compliance_decisions
    ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE compliance_decisions
    ALTER COLUMN intent_hash SET NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'idempotency_keys'::regclass
          AND conname = 'idempotency_keys_pkey'
    ) THEN
        ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
    END IF;
END $$;

ALTER TABLE idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (actor_id, endpoint, idempotency_key);

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
CREATE INDEX IF NOT EXISTS idx_idempotency_actor_endpoint_created_at ON idempotency_keys(actor_id, endpoint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_request_id ON audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_id ON audit_log(action_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_idempotency_key ON audit_log(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_audit_log_route_created_at ON audit_log(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_status_created_at ON audit_log(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_failed_operations_state_last_failed_at ON failed_operations(failure_state, last_failed_at DESC, failed_operation_id DESC);
CREATE INDEX IF NOT EXISTS idx_failed_operations_replay_eligible_last_failed_at ON failed_operations(replay_eligible, last_failed_at DESC, failed_operation_id DESC);
CREATE INDEX IF NOT EXISTS idx_failed_operations_request_id ON failed_operations(request_id);
CREATE INDEX IF NOT EXISTS idx_failed_operations_idempotency_key ON failed_operations(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_access_log_created_at ON access_log_entries(created_at DESC, entry_id DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_event_type_created_at ON access_log_entries(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_actor_created_at ON access_log_entries(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_request_id ON access_log_entries(request_id);
CREATE INDEX IF NOT EXISTS idx_governance_actions_created_at ON governance_actions(created_at DESC, action_id DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_category_status_created_at ON governance_actions(category, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_trade_id_created_at ON governance_actions(trade_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_intent_key_status_created_at ON governance_actions(intent_key, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_actions_actor_endpoint_idempotency ON governance_actions(actor_id, endpoint, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_governance_actions_intent_hash_status_created_at ON governance_actions(intent_hash, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_requested_expires_at ON governance_actions(expires_at ASC, action_id ASC)
WHERE status = 'requested' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_trade_id_decided_at ON compliance_decisions(trade_id, decided_at DESC, decision_id DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_result_decided_at ON compliance_decisions(result, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_reason_code_decided_at ON compliance_decisions(reason_code, decided_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_decisions_actor_endpoint_idempotency ON compliance_decisions(actor_id, endpoint, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_intent_hash_decided_at ON compliance_decisions(intent_hash, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_progression_blocks_state_updated_at ON oracle_progression_blocks(block_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_progression_blocks_latest_decision_id ON oracle_progression_blocks(latest_decision_id);
CREATE INDEX IF NOT EXISTS idx_evidence_bundles_trade_id_created_at ON evidence_bundles(trade_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_auth_nonces_expires_at ON service_auth_nonces(expires_at ASC);
CREATE INDEX IF NOT EXISTS idx_settlement_handoffs_trade_id_updated_at ON settlement_handoffs(trade_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_handoffs_execution_status_updated_at ON settlement_handoffs(execution_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_handoffs_reconciliation_status_updated_at ON settlement_handoffs(reconciliation_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_events_handoff_observed_at ON settlement_execution_events(handoff_id, observed_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_events_event_type_created_at ON settlement_execution_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_callback_deliveries_status_next_attempt_at ON settlement_callback_deliveries(status, next_attempt_at ASC, created_at ASC);
