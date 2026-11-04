SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';
CREATE FUNCTION public.current_app_service_name() RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(current_setting('app.service_name', true), '');
$$;
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE public.access_log_entries (
    entry_id text NOT NULL,
    event_type text NOT NULL,
    surface text NOT NULL,
    outcome text NOT NULL,
    actor_user_id text NOT NULL,
    actor_wallet_address text,
    actor_role text NOT NULL,
    session_fingerprint text NOT NULL,
    session_display text NOT NULL,
    ip_fingerprint text,
    ip_display text,
    user_agent text,
    request_id text NOT NULL,
    correlation_id text,
    request_method text NOT NULL,
    request_route text NOT NULL,
    audit_references jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.access_log_entries FORCE ROW LEVEL SECURITY;
CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    event_type text NOT NULL,
    route text NOT NULL,
    method text NOT NULL,
    request_id text NOT NULL,
    correlation_id text,
    action_id text,
    idempotency_key text,
    actor_id text,
    actor_user_id text,
    actor_wallet_address text,
    actor_role text,
    status text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.audit_log FORCE ROW LEVEL SECURITY;
CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;
CREATE TABLE public.compliance_decisions (
    decision_id text DEFAULT (gen_random_uuid())::text NOT NULL,
    trade_id text NOT NULL,
    decision_type text NOT NULL,
    result text NOT NULL,
    reason_code text NOT NULL,
    provider text NOT NULL,
    provider_ref text NOT NULL,
    subject_id text NOT NULL,
    subject_type text NOT NULL,
    risk_level text,
    correlation_id text NOT NULL,
    override_window_ends_at timestamp without time zone,
    idempotency_key text NOT NULL,
    actor_id text NOT NULL,
    endpoint text NOT NULL,
    intent_hash text NOT NULL,
    reason text NOT NULL,
    evidence_links jsonb DEFAULT '[]'::jsonb NOT NULL,
    ticket_ref text NOT NULL,
    actor_session_id text NOT NULL,
    actor_wallet text NOT NULL,
    actor_role text NOT NULL,
    requested_by text NOT NULL,
    approved_by jsonb DEFAULT '[]'::jsonb NOT NULL,
    decided_at timestamp without time zone NOT NULL,
    attestation_ref jsonb,
    CONSTRAINT compliance_decisions_decision_type_check CHECK ((decision_type = ANY (ARRAY['KYB'::text, 'KYT'::text, 'SANCTIONS'::text]))),
    CONSTRAINT compliance_decisions_result_check CHECK ((result = ANY (ARRAY['ALLOW'::text, 'DENY'::text]))),
    CONSTRAINT compliance_decisions_risk_level_check CHECK ((risk_level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))
);
ALTER TABLE ONLY public.compliance_decisions FORCE ROW LEVEL SECURITY;
CREATE TABLE public.evidence_bundles (
    bundle_id text NOT NULL,
    trade_id text NOT NULL,
    manifest_digest text NOT NULL,
    ricardian_hash text,
    generated_at timestamp without time zone NOT NULL,
    generated_by_user_id text NOT NULL,
    generated_by_wallet text,
    generated_by_role text NOT NULL,
    request_id text NOT NULL,
    correlation_id text,
    manifest jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.evidence_bundles FORCE ROW LEVEL SECURITY;
CREATE TABLE public.failed_operations (
    failed_operation_id text DEFAULT (gen_random_uuid())::text NOT NULL,
    operation_type text NOT NULL,
    operation_key text NOT NULL,
    target_service text NOT NULL,
    route text NOT NULL,
    method text NOT NULL,
    payload_hash text NOT NULL,
    request_payload jsonb,
    request_id text NOT NULL,
    correlation_id text,
    idempotency_key text,
    action_key text,
    actor_id text,
    actor_user_id text,
    actor_wallet_address text,
    actor_role text,
    session_reference text,
    replay_eligible boolean DEFAULT true NOT NULL,
    failure_state text NOT NULL,
    first_failed_at timestamp without time zone NOT NULL,
    last_failed_at timestamp without time zone NOT NULL,
    retry_count integer DEFAULT 1 NOT NULL,
    terminal_error_class text NOT NULL,
    terminal_error_code text NOT NULL,
    terminal_error_message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_replayed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT failed_operations_failure_state_check CHECK ((failure_state = ANY (ARRAY['open'::text, 'replayed'::text, 'replay_failed'::text]))),
    CONSTRAINT failed_operations_terminal_error_class_check CHECK ((terminal_error_class = ANY (ARRAY['client_contract'::text, 'upstream_business'::text, 'infrastructure'::text, 'unexpected'::text])))
);
ALTER TABLE ONLY public.failed_operations FORCE ROW LEVEL SECURITY;
CREATE TABLE public.idempotency_keys (
    actor_id text NOT NULL,
    endpoint text NOT NULL,
    idempotency_key text NOT NULL,
    request_method text NOT NULL,
    request_path text NOT NULL,
    request_fingerprint text NOT NULL,
    request_id text NOT NULL,
    response_status integer,
    response_headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_body jsonb,
    completed_at timestamp without time zone,
    last_replayed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE TABLE public.oracle_progression_blocks (
    trade_id text NOT NULL,
    latest_decision_id text NOT NULL,
    block_state text NOT NULL,
    reason_code text NOT NULL,
    request_id text NOT NULL,
    correlation_id text,
    audit_reason text NOT NULL,
    evidence_links jsonb DEFAULT '[]'::jsonb NOT NULL,
    ticket_ref text NOT NULL,
    actor_session_id text NOT NULL,
    actor_wallet text NOT NULL,
    actor_role text NOT NULL,
    requested_by text NOT NULL,
    approved_by jsonb DEFAULT '[]'::jsonb NOT NULL,
    blocked_at timestamp without time zone,
    resumed_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT oracle_progression_blocks_block_state_check CHECK ((block_state = ANY (ARRAY['not_blocked'::text, 'blocked'::text, 'resume_pending'::text])))
);
ALTER TABLE ONLY public.oracle_progression_blocks FORCE ROW LEVEL SECURITY;
CREATE TABLE public.role_assignments (
    assignment_id text NOT NULL,
    subject_user_id text NOT NULL,
    subject_wallet_address text NOT NULL,
    auth_role text NOT NULL,
    gateway_roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    source text NOT NULL,
    assigned_by_user_id text,
    assigned_by_wallet_address text,
    assigned_at timestamp without time zone NOT NULL,
    last_verified_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.role_assignments FORCE ROW LEVEL SECURITY;
CREATE TABLE public.service_auth_nonces (
    api_key text NOT NULL,
    nonce text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.service_auth_nonces FORCE ROW LEVEL SECURITY;
CREATE TABLE public.settlement_callback_deliveries (
    delivery_id text NOT NULL,
    handoff_id text NOT NULL,
    event_id text NOT NULL,
    target_url text NOT NULL,
    request_body jsonb NOT NULL,
    status text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp without time zone NOT NULL,
    last_attempted_at timestamp without time zone,
    delivered_at timestamp without time zone,
    response_status integer,
    last_error text,
    request_id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_callback_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivering'::text, 'delivered'::text, 'failed'::text, 'dead_letter'::text, 'disabled'::text])))
);
ALTER TABLE ONLY public.settlement_callback_deliveries FORCE ROW LEVEL SECURITY;
CREATE TABLE public.settlement_execution_events (
    event_id text NOT NULL,
    handoff_id text NOT NULL,
    event_type text NOT NULL,
    execution_status text NOT NULL,
    reconciliation_status text NOT NULL,
    provider_status text,
    tx_hash text,
    detail text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    observed_at timestamp without time zone NOT NULL,
    request_id text NOT NULL,
    source_api_key_id text,
    dedupe_key text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_execution_events_event_type_check CHECK ((event_type = ANY (ARRAY['accepted'::text, 'queued'::text, 'simulation_completed'::text, 'submitted'::text, 'confirmed'::text, 'failed'::text, 'rejected'::text, 'reconciled'::text, 'drift_detected'::text]))),
    CONSTRAINT settlement_execution_events_execution_status_check CHECK ((execution_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'queued'::text, 'submitted'::text, 'confirmed'::text, 'failed'::text, 'rejected'::text]))),
    CONSTRAINT settlement_execution_events_reconciliation_status_check CHECK ((reconciliation_status = ANY (ARRAY['pending'::text, 'matched'::text, 'drift'::text, 'unavailable'::text])))
);
ALTER TABLE ONLY public.settlement_execution_events FORCE ROW LEVEL SECURITY;
CREATE TABLE public.settlement_handoffs (
    handoff_id text NOT NULL,
    platform_id text NOT NULL,
    platform_handoff_id text NOT NULL,
    trade_id text NOT NULL,
    phase text NOT NULL,
    settlement_channel text NOT NULL,
    display_currency text NOT NULL,
    display_amount numeric(20,2) NOT NULL,
    asset_symbol text,
    asset_amount numeric(36,6),
    ricardian_hash text,
    external_reference text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    execution_status text NOT NULL,
    reconciliation_status text NOT NULL,
    callback_status text NOT NULL,
    provider_status text,
    tx_hash text,
    latest_event_id text,
    latest_event_type text,
    latest_event_detail text,
    latest_event_at timestamp without time zone,
    callback_delivered_at timestamp without time zone,
    request_id text NOT NULL,
    source_api_key_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_handoffs_callback_status_check CHECK ((callback_status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text, 'dead_letter'::text, 'disabled'::text]))),
    CONSTRAINT settlement_handoffs_execution_status_check CHECK ((execution_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'queued'::text, 'submitted'::text, 'confirmed'::text, 'failed'::text, 'rejected'::text]))),
    CONSTRAINT settlement_handoffs_reconciliation_status_check CHECK ((reconciliation_status = ANY (ARRAY['pending'::text, 'matched'::text, 'drift'::text, 'unavailable'::text])))
);
ALTER TABLE ONLY public.settlement_handoffs FORCE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);
ALTER TABLE ONLY public.access_log_entries
    ADD CONSTRAINT access_log_entries_pkey PRIMARY KEY (entry_id);
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.compliance_decisions
    ADD CONSTRAINT compliance_decisions_pkey PRIMARY KEY (decision_id);
ALTER TABLE ONLY public.evidence_bundles
    ADD CONSTRAINT evidence_bundles_pkey PRIMARY KEY (bundle_id);
ALTER TABLE ONLY public.failed_operations
    ADD CONSTRAINT failed_operations_operation_type_operation_key_key UNIQUE (operation_type, operation_key);
ALTER TABLE ONLY public.failed_operations
    ADD CONSTRAINT failed_operations_pkey PRIMARY KEY (failed_operation_id);
ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (actor_id, endpoint, idempotency_key);
ALTER TABLE ONLY public.oracle_progression_blocks
    ADD CONSTRAINT oracle_progression_blocks_pkey PRIMARY KEY (trade_id);
ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_pkey PRIMARY KEY (assignment_id);
ALTER TABLE ONLY public.service_auth_nonces
    ADD CONSTRAINT service_auth_nonces_pkey PRIMARY KEY (api_key, nonce);
ALTER TABLE ONLY public.settlement_callback_deliveries
    ADD CONSTRAINT settlement_callback_deliveries_pkey PRIMARY KEY (delivery_id);
ALTER TABLE ONLY public.settlement_execution_events
    ADD CONSTRAINT settlement_execution_events_pkey PRIMARY KEY (event_id);
ALTER TABLE ONLY public.settlement_handoffs
    ADD CONSTRAINT settlement_handoffs_pkey PRIMARY KEY (handoff_id);
ALTER TABLE ONLY public.settlement_handoffs
    ADD CONSTRAINT settlement_handoffs_platform_id_platform_handoff_id_key UNIQUE (platform_id, platform_handoff_id);
CREATE INDEX idx_access_log_actor_created_at ON public.access_log_entries USING btree (actor_user_id, created_at DESC);
CREATE INDEX idx_access_log_created_at ON public.access_log_entries USING btree (created_at DESC, entry_id DESC);
CREATE INDEX idx_access_log_event_type_created_at ON public.access_log_entries USING btree (event_type, created_at DESC);
CREATE INDEX idx_access_log_request_id ON public.access_log_entries USING btree (request_id);
CREATE INDEX idx_audit_log_action_id ON public.audit_log USING btree (action_id);
CREATE INDEX idx_audit_log_idempotency_key ON public.audit_log USING btree (idempotency_key);
CREATE INDEX idx_audit_log_request_id ON public.audit_log USING btree (request_id);
CREATE INDEX idx_audit_log_route_created_at ON public.audit_log USING btree (route, created_at DESC);
CREATE INDEX idx_audit_log_status_created_at ON public.audit_log USING btree (status, created_at DESC);
CREATE UNIQUE INDEX idx_compliance_decisions_actor_endpoint_idempotency ON public.compliance_decisions USING btree (actor_id, endpoint, idempotency_key);
CREATE INDEX idx_compliance_decisions_intent_hash_decided_at ON public.compliance_decisions USING btree (intent_hash, decided_at DESC);
CREATE INDEX idx_compliance_decisions_reason_code_decided_at ON public.compliance_decisions USING btree (reason_code, decided_at DESC);
CREATE INDEX idx_compliance_decisions_result_decided_at ON public.compliance_decisions USING btree (result, decided_at DESC);
CREATE INDEX idx_compliance_decisions_trade_id_decided_at ON public.compliance_decisions USING btree (trade_id, decided_at DESC, decision_id DESC);
CREATE INDEX idx_evidence_bundles_trade_id_created_at ON public.evidence_bundles USING btree (trade_id, created_at DESC);
CREATE INDEX idx_failed_operations_idempotency_key ON public.failed_operations USING btree (idempotency_key);
CREATE INDEX idx_failed_operations_replay_eligible_last_failed_at ON public.failed_operations USING btree (replay_eligible, last_failed_at DESC, failed_operation_id DESC);
CREATE INDEX idx_failed_operations_request_id ON public.failed_operations USING btree (request_id);
CREATE INDEX idx_failed_operations_state_last_failed_at ON public.failed_operations USING btree (failure_state, last_failed_at DESC, failed_operation_id DESC);
CREATE INDEX idx_idempotency_actor_endpoint_created_at ON public.idempotency_keys USING btree (actor_id, endpoint, created_at DESC);
CREATE INDEX idx_idempotency_completed_at ON public.idempotency_keys USING btree (completed_at DESC NULLS LAST);
CREATE INDEX idx_idempotency_created_at ON public.idempotency_keys USING btree (created_at DESC);
CREATE INDEX idx_oracle_progression_blocks_latest_decision_id ON public.oracle_progression_blocks USING btree (latest_decision_id);
CREATE INDEX idx_oracle_progression_blocks_state_updated_at ON public.oracle_progression_blocks USING btree (block_state, updated_at DESC);
CREATE INDEX idx_service_auth_nonces_expires_at ON public.service_auth_nonces USING btree (expires_at);
CREATE INDEX idx_settlement_callback_deliveries_status_next_attempt_at ON public.settlement_callback_deliveries USING btree (status, next_attempt_at, created_at);
CREATE INDEX idx_settlement_events_event_type_created_at ON public.settlement_execution_events USING btree (event_type, created_at DESC);
CREATE INDEX idx_settlement_events_handoff_observed_at ON public.settlement_execution_events USING btree (handoff_id, observed_at DESC, event_id DESC);
CREATE INDEX idx_settlement_handoffs_execution_status_updated_at ON public.settlement_handoffs USING btree (execution_status, updated_at DESC);
CREATE INDEX idx_settlement_handoffs_reconciliation_status_updated_at ON public.settlement_handoffs USING btree (reconciliation_status, updated_at DESC);
CREATE INDEX idx_settlement_handoffs_trade_id_updated_at ON public.settlement_handoffs USING btree (trade_id, updated_at DESC);
CREATE UNIQUE INDEX uq_settlement_events_handoff_dedupe_key ON public.settlement_execution_events USING btree (handoff_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);
ALTER TABLE ONLY public.oracle_progression_blocks
    ADD CONSTRAINT oracle_progression_blocks_latest_decision_id_fkey FOREIGN KEY (latest_decision_id) REFERENCES public.compliance_decisions(decision_id);
ALTER TABLE ONLY public.settlement_callback_deliveries
    ADD CONSTRAINT settlement_callback_deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.settlement_execution_events(event_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.settlement_callback_deliveries
    ADD CONSTRAINT settlement_callback_deliveries_handoff_id_fkey FOREIGN KEY (handoff_id) REFERENCES public.settlement_handoffs(handoff_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.settlement_execution_events
    ADD CONSTRAINT settlement_execution_events_handoff_id_fkey FOREIGN KEY (handoff_id) REFERENCES public.settlement_handoffs(handoff_id) ON DELETE CASCADE;
ALTER TABLE public.access_log_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_log_entries_service_isolation ON public.access_log_entries USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_service_isolation ON public.audit_log USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.compliance_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY compliance_decisions_service_isolation ON public.compliance_decisions USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.evidence_bundles ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_bundles_service_isolation ON public.evidence_bundles USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.failed_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY failed_operations_service_isolation ON public.failed_operations USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_service_isolation ON public.idempotency_keys USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.oracle_progression_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY oracle_progression_blocks_service_isolation ON public.oracle_progression_blocks USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.role_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_assignments_service_isolation ON public.role_assignments USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.service_auth_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_auth_nonces_service_isolation ON public.service_auth_nonces USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.settlement_callback_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY settlement_callback_deliveries_service_isolation ON public.settlement_callback_deliveries USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.settlement_execution_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY settlement_execution_events_service_isolation ON public.settlement_execution_events USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
ALTER TABLE public.settlement_handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY settlement_handoffs_service_isolation ON public.settlement_handoffs USING ((public.current_app_service_name() = 'gateway'::text)) WITH CHECK ((public.current_app_service_name() = 'gateway'::text));
