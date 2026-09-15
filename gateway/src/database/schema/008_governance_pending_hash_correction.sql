-- SPDX-License-Identifier: Apache-2.0

-- A reported transaction hash is provisional until the chain transaction is
-- observed and verified. Permit correction only while that exact state remains
-- pending; verified and terminal transaction evidence remains immutable.
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

    IF OLD.tx_hash IS NOT NULL
       AND OLD.tx_hash IS DISTINCT FROM NEW.tx_hash
       AND NOT (
           OLD.status = 'broadcast_pending_verification'
           AND OLD.verification_state = 'pending'
           AND NEW.tx_hash IS NOT NULL
       ) THEN
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
