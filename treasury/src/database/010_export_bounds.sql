-- Nontransactional sequence fences detect writes without serializing financial writers.
SET LOCAL lock_timeout = '5s';
CREATE SEQUENCE treasury_export_ledger_generation CACHE 1;
CREATE SEQUENCE treasury_export_payout_generation CACHE 1;
CREATE SEQUENCE treasury_export_bank_generation CACHE 1;
CREATE SEQUENCE treasury_export_ingestion_generation CACHE 1;
CREATE FUNCTION advance_treasury_export_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    CASE TG_TABLE_NAME
        WHEN 'treasury_ledger_entries' THEN PERFORM nextval('public.treasury_export_ledger_generation');
        WHEN 'payout_lifecycle_events' THEN PERFORM nextval('public.treasury_export_payout_generation');
        WHEN 'bank_payout_confirmations' THEN PERFORM nextval('public.treasury_export_bank_generation');
        WHEN 'treasury_ingestion_state' THEN PERFORM nextval('public.treasury_export_ingestion_generation');
        ELSE RAISE EXCEPTION 'unexpected_export_source';
    END CASE;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION advance_treasury_export_generation() FROM PUBLIC;
CREATE TRIGGER treasury_export_source_generation AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON treasury_ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION advance_treasury_export_generation();
CREATE TRIGGER treasury_export_source_generation AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON payout_lifecycle_events
FOR EACH STATEMENT EXECUTE FUNCTION advance_treasury_export_generation();
CREATE TRIGGER treasury_export_source_generation AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON bank_payout_confirmations
FOR EACH STATEMENT EXECUTE FUNCTION advance_treasury_export_generation();
CREATE TRIGGER treasury_export_source_generation AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON treasury_ingestion_state
FOR EACH STATEMENT EXECUTE FUNCTION advance_treasury_export_generation();
DO $$
DECLARE runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT ON SEQUENCE treasury_export_ledger_generation, treasury_export_payout_generation, treasury_export_bank_generation, treasury_export_ingestion_generation TO %I', runtime_user);
    END IF;
END $$;

-- Lifetime admission budgets include failed, expired, and completed jobs.
-- Retained evidence cannot be deleted by the runtime to reset these budgets.
CREATE FUNCTION bound_treasury_export_storage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM pg_advisory_xact_lock(20261102, 896);
        IF EXISTS (SELECT 1 FROM public.treasury_export_jobs WHERE caller_id=NEW.caller_id AND idempotency_key_hash=NEW.idempotency_key_hash) THEN
            RETURN NEW;
        END IF;
        IF (SELECT count(*) FROM public.treasury_export_jobs WHERE caller_id=NEW.caller_id) >= 10
           OR (SELECT count(*) FROM public.treasury_export_jobs) >= 100 THEN
            RAISE EXCEPTION 'treasury_export_storage_budget_exceeded';
        END IF;
    ELSIF NEW.attempt > 3 THEN
        RAISE EXCEPTION 'treasury_export_attempt_budget_exceeded';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER treasury_export_storage_budget BEFORE INSERT OR UPDATE ON treasury_export_jobs
FOR EACH ROW EXECUTE FUNCTION bound_treasury_export_storage();

-- Deterministic opaque continuations reuse one retained token per position.
ALTER TABLE treasury_export_jobs ADD COLUMN continuation_secret TEXT NOT NULL
    DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    CHECK (continuation_secret ~ '^[0-9a-f]{64}$');
-- Old hashes remain resolvable during the coordinated writer cutover.
ALTER TABLE treasury_export_tokens ADD COLUMN token_version SMALLINT NOT NULL DEFAULT 0
    CHECK (token_version IN (0,1));
CREATE UNIQUE INDEX treasury_export_tokens_position_idx ON treasury_export_tokens(job_id, caller_id, next_position) WHERE token_version=1;
CREATE FUNCTION bound_treasury_export_tokens() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE row_count BIGINT;
BEGIN
    IF NEW.token_version <> 1 THEN RAISE EXCEPTION 'treasury_export_token_writer_upgrade_required'; END IF;
    SELECT candidate_count INTO row_count FROM public.treasury_export_jobs
      WHERE id=NEW.job_id AND caller_id=NEW.caller_id AND status='COMPLETE';
    IF row_count IS NULL OR NEW.next_position > row_count THEN
        RAISE EXCEPTION 'treasury_export_token_position_exceeded';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER treasury_export_token_budget BEFORE INSERT ON treasury_export_tokens
FOR EACH ROW EXECUTE FUNCTION bound_treasury_export_tokens();
