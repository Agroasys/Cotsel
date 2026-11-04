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
CREATE FUNCTION public.current_app_service_name() RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(current_setting('app.service_name', true), '');
$$;
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE public.oracle_hmac_nonces (
    api_key character varying(128) NOT NULL,
    nonce character varying(255) NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);
ALTER TABLE ONLY public.oracle_hmac_nonces FORCE ROW LEVEL SECURITY;
CREATE TABLE public.oracle_triggers (
    id integer NOT NULL,
    action_key character varying(255) NOT NULL,
    request_id character varying(255) NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    trade_id character varying(100) NOT NULL,
    trigger_type character varying(50) NOT NULL,
    request_hash character varying(66),
    attempt_count integer DEFAULT 0,
    status character varying(30) NOT NULL,
    tx_hash character varying(66),
    block_number bigint,
    confirmation_stage character varying(16),
    confirmation_stage_at timestamp without time zone,
    indexer_confirmed boolean DEFAULT false,
    indexer_confirmed_at timestamp without time zone,
    indexer_event_id character varying(255),
    last_error text,
    error_type character varying(50),
    on_chain_verified boolean DEFAULT false,
    on_chain_verified_at timestamp without time zone,
    approved_by character varying(255),
    approved_at timestamp without time zone,
    rejected_by character varying(255),
    rejected_at timestamp without time zone,
    rejection_reason text,
    created_at timestamp without time zone DEFAULT now(),
    submitted_at timestamp without time zone,
    confirmed_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT check_confirmation_stage CHECK (((confirmation_stage IS NULL) OR ((confirmation_stage)::text = ANY ((ARRAY['INDEXED'::character varying, 'SAFE'::character varying, 'FINALIZED'::character varying])::text[])))),
    CONSTRAINT check_error_type CHECK (((error_type)::text = ANY ((ARRAY['VALIDATION'::character varying, 'NETWORK'::character varying, 'CONTRACT'::character varying, 'TERMINAL'::character varying, 'INDEXER_LAG'::character varying])::text[]))),
    CONSTRAINT check_status CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'EXECUTING'::character varying, 'SUBMITTED'::character varying, 'CONFIRMED'::character varying, 'FAILED'::character varying, 'EXHAUSTED_NEEDS_REDRIVE'::character varying, 'TERMINAL_FAILURE'::character varying, 'PENDING_APPROVAL'::character varying, 'REJECTED'::character varying])::text[]))),
    CONSTRAINT check_trigger_type CHECK (((trigger_type)::text = ANY ((ARRAY['RELEASE_STAGE_1'::character varying, 'CONFIRM_ARRIVAL'::character varying, 'CONFIRM_INSPECTION_AVAILABLE_STANDARD'::character varying, 'CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL'::character varying, 'FINALIZE_AFTER_INSPECTION_ACCEPTANCE'::character varying, 'FINALIZE_TRADE'::character varying])::text[])))
);
ALTER TABLE ONLY public.oracle_triggers FORCE ROW LEVEL SECURITY;
CREATE SEQUENCE public.oracle_triggers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.oracle_triggers_id_seq OWNED BY public.oracle_triggers.id;
ALTER TABLE ONLY public.oracle_triggers ALTER COLUMN id SET DEFAULT nextval('public.oracle_triggers_id_seq'::regclass);
ALTER TABLE ONLY public.oracle_hmac_nonces
    ADD CONSTRAINT oracle_hmac_nonces_pkey PRIMARY KEY (api_key, nonce);
ALTER TABLE ONLY public.oracle_triggers
    ADD CONSTRAINT oracle_triggers_pkey PRIMARY KEY (idempotency_key);
CREATE INDEX idx_action_key ON public.oracle_triggers USING btree (action_key);
CREATE UNIQUE INDEX idx_active_action_key_unique ON public.oracle_triggers USING btree (action_key) WHERE ((status)::text = ANY ((ARRAY['PENDING'::character varying, 'EXECUTING'::character varying, 'SUBMITTED'::character varying, 'PENDING_APPROVAL'::character varying])::text[]));
CREATE INDEX idx_created_at ON public.oracle_triggers USING btree (created_at DESC);
CREATE INDEX idx_exhausted_needs_redrive ON public.oracle_triggers USING btree (status, updated_at) WHERE ((status)::text = 'EXHAUSTED_NEEDS_REDRIVE'::text);
CREATE INDEX idx_oracle_hmac_nonces_expires_at ON public.oracle_hmac_nonces USING btree (expires_at);
CREATE INDEX idx_pending_approval ON public.oracle_triggers USING btree (status, created_at) WHERE ((status)::text = 'PENDING_APPROVAL'::text);
CREATE INDEX idx_request_id ON public.oracle_triggers USING btree (request_id);
CREATE INDEX idx_status ON public.oracle_triggers USING btree (status);
CREATE INDEX idx_submitted_unconfirmed ON public.oracle_triggers USING btree (status, submitted_at) WHERE (((status)::text = 'SUBMITTED'::text) AND (indexer_confirmed = false));
CREATE INDEX idx_trade_id ON public.oracle_triggers USING btree (trade_id);
ALTER TABLE public.oracle_hmac_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY oracle_hmac_nonces_service_isolation ON public.oracle_hmac_nonces USING ((public.current_app_service_name() = 'oracle'::text)) WITH CHECK ((public.current_app_service_name() = 'oracle'::text));
ALTER TABLE public.oracle_triggers ENABLE ROW LEVEL SECURITY;
CREATE POLICY oracle_triggers_service_isolation ON public.oracle_triggers USING ((public.current_app_service_name() = 'oracle'::text)) WITH CHECK ((public.current_app_service_name() = 'oracle'::text));
