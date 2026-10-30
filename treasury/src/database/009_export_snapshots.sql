-- Durable construction state for historical Treasury exports. Runtime has no
-- DELETE grant: evidence retention and approved cleanup are operator controls.
SET LOCAL lock_timeout = '5s';

CREATE TABLE treasury_export_jobs (
    id UUID PRIMARY KEY,
    caller_id TEXT NOT NULL CHECK (length(caller_id) BETWEEN 1 AND 255),
    idempotency_key_hash CHAR(64) NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
    request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    cutoff TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('BUILDING', 'FAILED', 'COMPLETE')),
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    lease_owner UUID,
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    candidate_count BIGINT CHECK (candidate_count >= 0),
    candidate_amount_raw TEXT CHECK (candidate_amount_raw ~ '^(0|[1-9][0-9]*)$'),
    chain_context JSONB,
    reconciliation_context JSONB,
    ingestion_context JSONB,
    failure_code TEXT,
    UNIQUE (caller_id, idempotency_key_hash),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK (status <> 'COMPLETE' OR (
        completed_at IS NOT NULL AND lease_owner IS NULL AND candidate_count IS NOT NULL
        AND candidate_amount_raw IS NOT NULL AND chain_context IS NOT NULL
        AND reconciliation_context IS NOT NULL AND ingestion_context IS NOT NULL
    )),
    CHECK (status <> 'FAILED' OR failure_code IS NOT NULL)
);

CREATE TABLE treasury_export_rows (
    job_id UUID NOT NULL REFERENCES treasury_export_jobs(id),
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    position BIGINT NOT NULL CHECK (position >= 0),
    ledger_entry_id INTEGER NOT NULL,
    captured_row JSONB NOT NULL,
    source_evidence JSONB NOT NULL,
    eligibility JSONB,
    PRIMARY KEY (job_id, attempt, position),
    UNIQUE (job_id, attempt, ledger_entry_id)
);

CREATE TABLE treasury_export_tokens (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    job_id UUID NOT NULL REFERENCES treasury_export_jobs(id),
    caller_id TEXT NOT NULL CHECK (length(caller_id) BETWEEN 1 AND 255),
    next_position BIGINT NOT NULL CHECK (next_position >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX treasury_export_jobs_expiry_idx ON treasury_export_jobs (access_expires_at, status);
CREATE INDEX treasury_export_jobs_lease_idx ON treasury_export_jobs (lease_expires_at)
    WHERE status = 'BUILDING';
CREATE INDEX treasury_export_tokens_expiry_idx ON treasury_export_tokens (expires_at);

-- Completed data is evidence, not a mutable cache. The retention owner must
-- approve any later custody or destruction procedure.
CREATE FUNCTION protect_completed_treasury_export() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE captured_count BIGINT;
DECLARE evaluated_count BIGINT;
DECLARE captured_amount NUMERIC;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'BUILDING' OR NEW.attempt <> 1 THEN
            RAISE EXCEPTION 'treasury_export_job_must_start_building';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' OR OLD.status = 'COMPLETE' THEN
        RAISE EXCEPTION 'treasury_export_job_is_retained';
    END IF;
    IF ROW(NEW.id, NEW.caller_id, NEW.idempotency_key_hash, NEW.request_hash, NEW.cutoff, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.caller_id, OLD.idempotency_key_hash, OLD.request_hash, OLD.cutoff, OLD.created_at) THEN
        RAISE EXCEPTION 'treasury_export_job_identity_is_immutable';
    END IF;
    IF NEW.status = 'COMPLETE' THEN
        IF OLD.status <> 'BUILDING' OR
           COALESCE(NEW.chain_context->>'finalizedBlockHash', '') !~ '^0x[0-9a-f]{64}$' OR
           COALESCE(NEW.chain_context->>'finalizedBlockNumber', '') !~ '^(0|[1-9][0-9]*)$' OR
           COALESCE(NEW.reconciliation_context->>'runKey', '') = '' OR
           NEW.ingestion_context->>'status' IS DISTINCT FROM 'FRESH' THEN
            RAISE EXCEPTION 'treasury_export_context_is_incomplete';
        END IF;
        SELECT count(*), count(*) FILTER (WHERE eligibility IS NOT NULL),
               sum(CASE WHEN captured_row->>'amount_raw' ~ '^(0|[1-9][0-9]*)$'
                        THEN (captured_row->>'amount_raw')::numeric ELSE NULL END)
          INTO captured_count, evaluated_count, captured_amount
          FROM public.treasury_export_rows WHERE job_id = NEW.id AND attempt = NEW.attempt;
        IF captured_count <> NEW.candidate_count OR evaluated_count <> captured_count
           OR COALESCE(captured_amount, 0)::text IS DISTINCT FROM NEW.candidate_amount_raw
           OR EXISTS (SELECT 1 FROM public.treasury_export_rows
                      WHERE job_id = NEW.id AND attempt = NEW.attempt
                        AND COALESCE(captured_row->>'amount_raw', '') !~ '^(0|[1-9][0-9]*)$') THEN
            RAISE EXCEPTION 'treasury_export_snapshot_is_incomplete';
        END IF;
        IF EXISTS (
            SELECT 1 FROM public.treasury_export_rows r
            WHERE r.job_id = NEW.id AND r.attempt = NEW.attempt AND (
                jsonb_typeof(r.eligibility->'eligibleForPayout') IS DISTINCT FROM 'boolean'
                OR jsonb_typeof(r.eligibility->'eligibleForExport') IS DISTINCT FROM 'boolean'
                OR jsonb_typeof(r.eligibility->'blockedReasons') IS DISTINCT FROM 'array'
                OR jsonb_typeof(r.eligibility->'exportBlockedReasons') IS DISTINCT FROM 'array'
                OR COALESCE(r.eligibility->>'canonicalityState', '') NOT IN ('CANONICAL', 'ORPHANED')
                OR r.eligibility->'reconciliationEvidence'->>'runKey' IS DISTINCT FROM NEW.reconciliation_context->>'runKey'
                OR r.eligibility->'reconciliationEvidence'->>'freshness' IS DISTINCT FROM 'FRESH'
                OR r.eligibility->'reconciliationEvidence'->'coverageComplete' IS DISTINCT FROM 'true'::jsonb
                OR CASE WHEN COALESCE(r.eligibility->'reconciliationEvidence'->>'coverageToBlock', '') ~ '^(0|[1-9][0-9]*)$'
                              AND COALESCE(r.captured_row->>'block_number', '') ~ '^(0|[1-9][0-9]*)$'
                        THEN (r.eligibility->'reconciliationEvidence'->>'coverageToBlock')::numeric < (r.captured_row->>'block_number')::numeric
                        ELSE true END
                OR CASE WHEN jsonb_typeof(r.eligibility->'exportBlockedReasons') = 'array'
                        THEN (r.eligibility->'eligibleForExport' = 'true'::jsonb) IS DISTINCT FROM
                             (jsonb_array_length(r.eligibility->'exportBlockedReasons') = 0)
                        ELSE true END
                OR (r.eligibility->'eligibleForPayout' = 'true'::jsonb AND (
                    r.eligibility->>'canonicalityState' IS DISTINCT FROM 'CANONICAL'
                    OR CASE WHEN jsonb_typeof(r.eligibility->'blockedReasons') = 'array'
                            THEN jsonb_array_length(r.eligibility->'blockedReasons') <> 0 ELSE true END
                ))
                OR (r.eligibility->'eligibleForExport' = 'true'::jsonb AND (
                    r.eligibility->'eligibleForPayout' IS DISTINCT FROM 'true'::jsonb
                    OR r.eligibility->>'canonicalityState' IS DISTINCT FROM 'CANONICAL'
                    OR CASE WHEN jsonb_typeof(r.eligibility->'blockedReasons') = 'array'
                            THEN jsonb_array_length(r.eligibility->'blockedReasons') <> 0 ELSE true END
                ))
            )
        ) THEN RAISE EXCEPTION 'treasury_export_eligibility_is_incomplete'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER treasury_export_job_retention BEFORE INSERT OR UPDATE OR DELETE ON treasury_export_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_completed_treasury_export();

CREATE FUNCTION protect_completed_treasury_export_row() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE parent_status TEXT;
DECLARE parent_attempt INTEGER;
DECLARE target_job UUID := CASE WHEN TG_OP = 'INSERT' THEN NEW.job_id ELSE OLD.job_id END;
BEGIN
    SELECT status, attempt INTO parent_status, parent_attempt
      FROM public.treasury_export_jobs WHERE id = target_job FOR SHARE;
    IF parent_status = 'COMPLETE' THEN
        RAISE EXCEPTION 'treasury_export_rows_are_retained';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF parent_status IS DISTINCT FROM 'BUILDING' OR NEW.job_id IS DISTINCT FROM target_job
       OR NEW.attempt IS DISTINCT FROM parent_attempt THEN
        RAISE EXCEPTION 'treasury_export_row_attempt_is_not_active';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER treasury_export_row_retention BEFORE INSERT OR UPDATE OR DELETE ON treasury_export_rows
    FOR EACH ROW EXECUTE FUNCTION protect_completed_treasury_export_row();

DO $$
DECLARE runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON treasury_export_jobs, treasury_export_rows TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT ON treasury_export_tokens TO %I', runtime_user);
    END IF;
END;
$$;

ALTER TABLE treasury_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY treasury_export_jobs_service_isolation ON treasury_export_jobs
    FOR ALL USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');
ALTER TABLE treasury_export_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_export_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY treasury_export_rows_service_isolation ON treasury_export_rows
    FOR ALL USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');
ALTER TABLE treasury_export_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_export_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY treasury_export_tokens_service_isolation ON treasury_export_tokens
    FOR ALL USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');
