-- SPDX-License-Identifier: Apache-2.0

-- Immutable operator intent and independently verified transaction evidence for
-- ADR-0411. This table contains no key material and no executable work queue.
CREATE TABLE IF NOT EXISTS governance_actions (
    action_id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    intent_key               TEXT NOT NULL,
    intent_hash              TEXT NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
    proposal_id              BIGINT CHECK (proposal_id IS NULL OR proposal_id >= 0),
    category                 TEXT NOT NULL CHECK (category IN (
        'pause',
        'unpause',
        'claims_pause',
        'claims_unpause',
        'treasury_sweep',
        'treasury_payout_receiver_update',
        'oracle_disable_emergency',
        'oracle_update'
    )),
    status                   TEXT NOT NULL CHECK (status IN (
        'prepared',
        'broadcast_pending_verification',
        'broadcast',
        'executed',
        'stale',
        'failed'
    )),
    flow_type                TEXT NOT NULL DEFAULT 'direct_sign' CHECK (flow_type = 'direct_sign'),
    contract_method          TEXT NOT NULL,
    tx_hash                  TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    block_number             BIGINT CHECK (block_number IS NULL OR block_number >= 0),
    trade_id                 TEXT,
    chain_id                 TEXT NOT NULL,
    target_address           TEXT,
    broadcast_at             TIMESTAMPTZ,
    request_id               TEXT NOT NULL,
    correlation_id           TEXT,
    idempotency_key          TEXT NOT NULL,
    actor_id                 TEXT NOT NULL,
    endpoint                 TEXT NOT NULL,
    reason                   TEXT NOT NULL,
    evidence_links           JSONB NOT NULL DEFAULT '[]'::jsonb,
    ticket_ref               TEXT NOT NULL,
    actor_session_id         TEXT NOT NULL,
    actor_wallet             TEXT,
    actor_role               TEXT NOT NULL,
    requested_by             TEXT NOT NULL,
    approved_by              JSONB NOT NULL DEFAULT '[]'::jsonb,
    actor_account_id         TEXT,
    signer_policy_evidence   JSONB NOT NULL DEFAULT '{}'::jsonb,
    final_signer_wallet      TEXT,
    verification_state       TEXT NOT NULL CHECK (verification_state IN (
        'not_started', 'pending', 'verified', 'failed'
    )),
    verification_error       TEXT,
    verified_at              TIMESTAMPTZ,
    monitoring_state         TEXT NOT NULL CHECK (monitoring_state IN (
        'not_started',
        'pending_verification',
        'pending_confirmation',
        'confirmed',
        'finalized',
        'reverted',
        'stale'
    )),
    prepared_signing_payload JSONB NOT NULL,
    error_code               TEXT,
    error_message            TEXT,
    created_at               TIMESTAMPTZ NOT NULL,
    expires_at               TIMESTAMPTZ NOT NULL,
    executed_at              TIMESTAMPTZ,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT governance_actions_payload_shape CHECK (
        jsonb_typeof(prepared_signing_payload) = 'object'
        AND prepared_signing_payload ?& ARRAY[
            'actionId', 'intentKey', 'actionType', 'proposalId', 'expiresAt',
            'auditReference', 'chainId', 'contractAddress', 'contractMethod',
            'args', 'txRequest', 'signerWallet', 'preparedPayloadHash'
        ]
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_actions_actor_endpoint_idempotency
    ON governance_actions(actor_id, endpoint, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_governance_actions_intent_status_created
    ON governance_actions(intent_key, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_status_created
    ON governance_actions(status, created_at DESC, action_id DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_category_created
    ON governance_actions(category, created_at DESC, action_id DESC);
CREATE INDEX IF NOT EXISTS idx_governance_actions_pending_monitor
    ON governance_actions(status, updated_at ASC)
    WHERE status IN ('broadcast_pending_verification', 'broadcast');

CREATE OR REPLACE FUNCTION prevent_governance_action_intent_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.intent_key IS DISTINCT FROM NEW.intent_key
       OR OLD.intent_hash IS DISTINCT FROM NEW.intent_hash
       OR OLD.proposal_id IS DISTINCT FROM NEW.proposal_id
       OR OLD.category IS DISTINCT FROM NEW.category
       OR OLD.flow_type IS DISTINCT FROM NEW.flow_type
       OR OLD.contract_method IS DISTINCT FROM NEW.contract_method
       OR OLD.trade_id IS DISTINCT FROM NEW.trade_id
       OR OLD.chain_id IS DISTINCT FROM NEW.chain_id
       OR OLD.target_address IS DISTINCT FROM NEW.target_address
       OR OLD.request_id IS DISTINCT FROM NEW.request_id
       OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
       OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR OLD.actor_id IS DISTINCT FROM NEW.actor_id
       OR OLD.endpoint IS DISTINCT FROM NEW.endpoint
       OR OLD.reason IS DISTINCT FROM NEW.reason
       OR OLD.evidence_links IS DISTINCT FROM NEW.evidence_links
       OR OLD.ticket_ref IS DISTINCT FROM NEW.ticket_ref
       OR OLD.actor_session_id IS DISTINCT FROM NEW.actor_session_id
       OR OLD.actor_wallet IS DISTINCT FROM NEW.actor_wallet
       OR OLD.actor_role IS DISTINCT FROM NEW.actor_role
       OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
       OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
       OR OLD.actor_account_id IS DISTINCT FROM NEW.actor_account_id
       OR OLD.signer_policy_evidence IS DISTINCT FROM NEW.signer_policy_evidence
       OR OLD.prepared_signing_payload IS DISTINCT FROM NEW.prepared_signing_payload
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
        RAISE EXCEPTION 'prepared governance intent and audit evidence are immutable';
    END IF;

    IF OLD.tx_hash IS NOT NULL AND OLD.tx_hash IS DISTINCT FROM NEW.tx_hash THEN
        RAISE EXCEPTION 'governance broadcast transaction hash is immutable';
    END IF;

    IF OLD.broadcast_at IS NOT NULL
       AND OLD.broadcast_at IS DISTINCT FROM NEW.broadcast_at THEN
        RAISE EXCEPTION 'governance broadcast timestamp is immutable';
    END IF;

    IF OLD.final_signer_wallet IS NOT NULL
       AND OLD.final_signer_wallet IS DISTINCT FROM NEW.final_signer_wallet THEN
        RAISE EXCEPTION 'verified governance signer is immutable';
    END IF;

    IF OLD.status IN ('executed', 'stale', 'failed') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'terminal governance action status is immutable';
    END IF;

    IF OLD.status = 'broadcast' AND NEW.status NOT IN ('broadcast', 'executed', 'stale', 'failed') THEN
        RAISE EXCEPTION 'invalid governance action transition from broadcast';
    END IF;

    IF OLD.status = 'broadcast_pending_verification'
       AND NEW.status NOT IN (
           'broadcast_pending_verification', 'broadcast', 'executed', 'stale', 'failed'
       ) THEN
        RAISE EXCEPTION 'invalid governance action transition from pending verification';
    END IF;

    IF OLD.status = 'prepared'
       AND NEW.status NOT IN ('prepared', 'broadcast_pending_verification', 'broadcast', 'failed') THEN
        RAISE EXCEPTION 'invalid governance action transition from prepared';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS governance_action_intent_immutable ON governance_actions;
CREATE TRIGGER governance_action_intent_immutable
    BEFORE UPDATE ON governance_actions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_governance_action_intent_mutation();

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    REVOKE ALL ON TABLE governance_actions FROM PUBLIC;
    IF runtime_user IS NOT NULL THEN
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE governance_actions TO %I',
            runtime_user
        );
    END IF;
END $$;

ALTER TABLE governance_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS governance_actions_service_isolation ON governance_actions;
CREATE POLICY governance_actions_service_isolation ON governance_actions
    FOR ALL
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');
