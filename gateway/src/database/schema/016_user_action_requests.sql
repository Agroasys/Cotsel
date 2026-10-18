-- Dormant execution authority. No migration changes activation policy.
CREATE TABLE gasless_user_action_requests (
 request_id UUID PRIMARY KEY,
 owner_service_id TEXT NOT NULL,
 source_operation_id TEXT NOT NULL,
 package_id TEXT NOT NULL,
 handoff_id TEXT NOT NULL REFERENCES settlement_handoffs(handoff_id) ON DELETE RESTRICT,
 chain_id BIGINT NOT NULL CHECK (chain_id > 0),
 escrow_address TEXT NOT NULL CHECK (escrow_address ~ '^0x[0-9a-f]{40}$'),
 user_address TEXT NOT NULL CHECK (user_address ~ '^0x[0-9a-f]{40}$'),
 authorization_nonce NUMERIC(78,0) NOT NULL CHECK (authorization_nonce >= 0),
 action TEXT NOT NULL CHECK (action IN ('finalize_after_inspection_acceptance','cancel_locked_timeout','refund_in_transit_timeout')),
 request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^0x[0-9a-f]{64}$'),
 binding_fingerprint TEXT NOT NULL CHECK (binding_fingerprint ~ '^0x[0-9a-f]{64}$'),
 execution_status TEXT NOT NULL DEFAULT 'accepted' CHECK (execution_status IN ('accepted','signing')),
 lease_token UUID,
 lease_expires_at TIMESTAMPTZ,
 signing_started_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(owner_service_id,source_operation_id),
 UNIQUE(owner_service_id,package_id),
 CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
 CHECK ((execution_status='accepted' AND signing_started_at IS NULL) OR
        (execution_status='signing' AND signing_started_at IS NOT NULL AND lease_token IS NULL))
);
CREATE TABLE gasless_user_action_attempt_events (
 event_id BIGSERIAL PRIMARY KEY,
 request_id UUID NOT NULL REFERENCES gasless_user_action_requests(request_id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL CHECK (event_type IN ('accepted','claimed','signing','signed','provider_hash','signer_rejected')),
 lease_token UUID,
 transaction_identity JSONB,
 transaction_hash TEXT CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE FUNCTION guard_user_action_request() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'user_action_request_delete_forbidden'; END IF;
 IF (to_jsonb(NEW) - ARRAY['execution_status','lease_token','lease_expires_at','signing_started_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['execution_status','lease_token','lease_expires_at','signing_started_at'])
 THEN RAISE EXCEPTION 'user_action_request_identity_immutable'; END IF;
 IF OLD.execution_status='signing' THEN RAISE EXCEPTION 'user_action_signing_irreversible'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER user_action_request_guard BEFORE UPDATE OR DELETE ON gasless_user_action_requests
 FOR EACH ROW EXECUTE FUNCTION guard_user_action_request();
CREATE FUNCTION guard_user_action_attempt_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'user_action_attempt_history_immutable'; END; $$;
CREATE TRIGGER user_action_attempt_event_guard BEFORE UPDATE OR DELETE ON gasless_user_action_attempt_events
 FOR EACH ROW EXECUTE FUNCTION guard_user_action_attempt_event();
CREATE INDEX idx_user_action_attempt_request ON gasless_user_action_attempt_events(request_id,event_id);
DO $$ DECLARE runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user',true),'');
BEGIN IF runtime_user IS NOT NULL THEN
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON gasless_user_action_requests TO %I',runtime_user);
 EXECUTE format('GRANT SELECT,INSERT ON gasless_user_action_attempt_events TO %I',runtime_user);
 EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE gasless_user_action_attempt_events_event_id_seq TO %I',runtime_user);
END IF; END $$;

CREATE TABLE gasless_user_action_nonce_owners (
 chain_id BIGINT NOT NULL,
 escrow_address TEXT NOT NULL,
 user_address TEXT NOT NULL,
 authorization_nonce NUMERIC(78,0) NOT NULL,
 request_id UUID NOT NULL REFERENCES gasless_user_action_requests(request_id) ON DELETE RESTRICT,
 PRIMARY KEY(chain_id,escrow_address,user_address,authorization_nonce)
);
CREATE TABLE gasless_user_action_retirement_events (
 event_id BIGSERIAL PRIMARY KEY,
 predecessor_request_id UUID NOT NULL REFERENCES gasless_user_action_requests(request_id) ON DELETE RESTRICT,
 successor_request_id UUID REFERENCES gasless_user_action_requests(request_id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL CHECK(event_type IN ('retired','drift')),
 evidence JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER user_action_retirement_event_guard BEFORE UPDATE OR DELETE ON gasless_user_action_retirement_events
 FOR EACH ROW EXECUTE FUNCTION guard_user_action_attempt_event();
DO $$ DECLARE runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user',true),'');
BEGIN IF runtime_user IS NOT NULL THEN
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON gasless_user_action_nonce_owners TO %I',runtime_user);
 EXECUTE format('GRANT SELECT,INSERT ON gasless_user_action_retirement_events TO %I',runtime_user);
 EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE gasless_user_action_retirement_events_event_id_seq TO %I',runtime_user);
END IF; END $$;

-- Match existing gateway service isolation for every new durable relation.
ALTER TABLE gasless_user_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE gasless_user_action_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY user_action_requests_service ON gasless_user_action_requests
 USING(current_app_service_name()='gateway') WITH CHECK(current_app_service_name()='gateway');
ALTER TABLE gasless_user_action_attempt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gasless_user_action_attempt_events FORCE ROW LEVEL SECURITY;
CREATE POLICY user_action_attempts_service ON gasless_user_action_attempt_events
 USING(current_app_service_name()='gateway') WITH CHECK(current_app_service_name()='gateway');
ALTER TABLE gasless_user_action_nonce_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE gasless_user_action_nonce_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY user_action_owners_service ON gasless_user_action_nonce_owners
 USING(current_app_service_name()='gateway') WITH CHECK(current_app_service_name()='gateway');
ALTER TABLE gasless_user_action_retirement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gasless_user_action_retirement_events FORCE ROW LEVEL SECURITY;
CREATE POLICY user_action_retirements_service ON gasless_user_action_retirement_events
 USING(current_app_service_name()='gateway') WITH CHECK(current_app_service_name()='gateway');
CREATE UNIQUE INDEX user_action_one_signing ON gasless_user_action_attempt_events(request_id) WHERE event_type='signing';
CREATE UNIQUE INDEX user_action_one_signed ON gasless_user_action_attempt_events(request_id) WHERE event_type='signed';
CREATE UNIQUE INDEX user_action_signed_hash ON gasless_user_action_attempt_events(transaction_hash) WHERE event_type='signed';
ALTER TABLE gasless_user_action_attempt_events ADD CHECK (
 (event_type='signed' AND transaction_hash IS NOT NULL AND transaction_identity IS NOT NULL)
 OR (event_type<>'signed' AND transaction_identity IS NULL));
CREATE FUNCTION guard_user_action_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target public.gasless_user_action_requests;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'user_action_nonce_owner_delete_forbidden'; END IF;
 SELECT * INTO STRICT target FROM public.gasless_user_action_requests WHERE request_id=NEW.request_id;
 IF ROW(NEW.chain_id,NEW.escrow_address,NEW.user_address,NEW.authorization_nonce)
 IS DISTINCT FROM ROW(target.chain_id,target.escrow_address,target.user_address,target.authorization_nonce)
 THEN RAISE EXCEPTION 'user_action_nonce_owner_scope_mismatch'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.chain_id,NEW.escrow_address,NEW.user_address,NEW.authorization_nonce)
  IS DISTINCT FROM ROW(OLD.chain_id,OLD.escrow_address,OLD.user_address,OLD.authorization_nonce)
  THEN RAISE EXCEPTION 'user_action_nonce_owner_identity_immutable'; END IF;
  IF NEW.request_id IS DISTINCT FROM OLD.request_id AND NOT EXISTS(
   SELECT 1 FROM public.gasless_user_action_retirement_events e
   WHERE e.predecessor_request_id=OLD.request_id AND e.successor_request_id=NEW.request_id AND e.event_type='retired')
  THEN RAISE EXCEPTION 'user_action_nonce_retirement_required'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER user_action_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON gasless_user_action_nonce_owners
 FOR EACH ROW EXECUTE FUNCTION guard_user_action_owner();
CREATE FUNCTION guard_user_action_signed_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public.gasless_user_action_requests; j JSONB := NEW.transaction_identity;
BEGIN
 IF NEW.event_type<>'signed' THEN RETURN NEW; END IF;
 SELECT * INTO STRICT r FROM public.gasless_user_action_requests WHERE request_id=NEW.request_id FOR UPDATE;
 IF r.execution_status<>'signing' OR NOT EXISTS(SELECT 1 FROM public.gasless_user_action_attempt_events WHERE request_id=r.request_id AND event_type='signing' AND lease_token=NEW.lease_token)
 THEN RAISE EXCEPTION 'user_action_signing_owner_required'; END IF;
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR
 (j - ARRAY['transactionHash','applicationRequestId','resourceType','resourceId','operation','chainId','signerAddress','nonce','transactionType','destinationAddress','valueWei','gasLimit','maxFeePerGasWei','maxPriorityFeePerGasWei','gasPriceWei','calldataHash','intentHash','sourceApiKeyId']) <> '{}'::jsonb OR
 (j ?& ARRAY['transactionHash','applicationRequestId','resourceType','resourceId','operation','chainId','signerAddress','nonce','transactionType','destinationAddress','valueWei','gasLimit','maxFeePerGasWei','maxPriorityFeePerGasWei','gasPriceWei','calldataHash','intentHash','sourceApiKeyId']) IS DISTINCT FROM true OR
 j->>'transactionHash' IS DISTINCT FROM NEW.transaction_hash OR
 j->>'applicationRequestId' IS DISTINCT FROM r.request_id::text OR
 j->>'resourceType' IS DISTINCT FROM 'settlement_handoff' OR
 j->>'resourceId' IS DISTINCT FROM r.handoff_id OR
 j->>'operation' IS DISTINCT FROM r.action OR
 j->>'sourceApiKeyId' IS DISTINCT FROM r.owner_service_id OR
 j->>'chainId' IS DISTINCT FROM r.chain_id::text OR
 lower(j->>'destinationAddress') IS DISTINCT FROM r.escrow_address OR j->>'valueWei' IS DISTINCT FROM '0' OR
 (j->>'signerAddress' ~ '^0x[0-9A-Fa-f]{40}$') IS DISTINCT FROM true OR
 (j->>'calldataHash' ~ '^0x[0-9a-f]{64}$') IS DISTINCT FROM true OR
 (j->>'intentHash' ~ '^0x[0-9a-f]{64}$') IS DISTINCT FROM true OR
 (j->>'nonce' ~ '^(0|[1-9][0-9]*)$') IS DISTINCT FROM true OR
 (j->>'gasLimit' ~ '^[1-9][0-9]*$') IS DISTINCT FROM true OR
 (j->>'transactionType' IN ('0','2')) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'user_action_signed_identity_invalid'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER user_action_signed_identity_guard BEFORE INSERT ON gasless_user_action_attempt_events
 FOR EACH ROW EXECUTE FUNCTION guard_user_action_signed_identity();
CREATE FUNCTION guard_user_action_retirement_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE predecessor public.gasless_user_action_requests; successor public.gasless_user_action_requests;
BEGIN
 SELECT * INTO STRICT predecessor FROM public.gasless_user_action_requests WHERE request_id=NEW.predecessor_request_id;
 IF NEW.event_type='retired' THEN
  SELECT * INTO STRICT successor FROM public.gasless_user_action_requests WHERE request_id=NEW.successor_request_id;
  IF ROW(predecessor.chain_id,predecessor.escrow_address,predecessor.user_address,predecessor.authorization_nonce)
  IS DISTINCT FROM ROW(successor.chain_id,successor.escrow_address,successor.user_address,successor.authorization_nonce)
  OR predecessor.request_id=successor.request_id OR
  NEW.evidence->'scope'->>'requestId' IS DISTINCT FROM predecessor.request_id::text OR
  NEW.evidence->'scope'->>'packageId' IS DISTINCT FROM predecessor.package_id OR
  NEW.evidence->'scope'->>'sourceOperationId' IS DISTINCT FROM predecessor.source_operation_id OR
  NEW.evidence->'scope'->>'requestFingerprint' IS DISTINCT FROM predecessor.request_fingerprint OR
  NEW.evidence->'scope'->>'bindingFingerprint' IS DISTINCT FROM predecessor.binding_fingerprint
  THEN RAISE EXCEPTION 'user_action_retirement_identity_mismatch'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER user_action_retirement_identity_guard BEFORE INSERT ON gasless_user_action_retirement_events
 FOR EACH ROW EXECUTE FUNCTION guard_user_action_retirement_identity();

-- Existing recorder/reconciler source remains unchanged. Only new lifecycle outcomes
-- participate in this nonce protocol. Snapshot readers do not lock outcome rows.
CREATE FUNCTION serialize_user_action_outcome() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public.gasless_user_action_requests; j JSONB;
BEGIN
 SELECT * INTO r FROM public.gasless_user_action_requests WHERE request_id::text=NEW.application_request_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('user-action:'||r.chain_id::text||':'||r.escrow_address||':'||r.user_address||':'||r.authorization_nonce::text,0));
 SELECT transaction_identity INTO j FROM public.gasless_user_action_attempt_events
 WHERE request_id=r.request_id AND event_type='signed' AND transaction_hash=NEW.transaction_hash;
 IF j IS NULL OR ROW(NEW.application_request_id,NEW.resource_type,NEW.resource_id,NEW.operation,NEW.chain_id::text,NEW.signer_address,NEW.transaction_nonce::text,NEW.transaction_type::text,NEW.destination_address,NEW.value_wei::text,NEW.gas_limit::text,NEW.max_fee_per_gas_wei::text,NEW.max_priority_fee_per_gas_wei::text,NEW.gas_price_wei::text,NEW.calldata_hash,NEW.intent_hash,NEW.source_api_key_id)
 IS DISTINCT FROM ROW(j->>'applicationRequestId',j->>'resourceType',j->>'resourceId',j->>'operation',j->>'chainId',j->>'signerAddress',j->>'nonce',j->>'transactionType',j->>'destinationAddress',j->>'valueWei',j->>'gasLimit',j->>'maxFeePerGasWei',j->>'maxPriorityFeePerGasWei',j->>'gasPriceWei',j->>'calldataHash',j->>'intentHash',j->>'sourceApiKeyId')
 THEN RAISE EXCEPTION 'user_action_outcome_requires_original_signed_identity'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER user_action_outcome_nonce_lock BEFORE INSERT OR UPDATE ON gasless_transaction_outcomes
 FOR EACH ROW EXECUTE FUNCTION serialize_user_action_outcome();
