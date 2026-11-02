-- Published runs are historical evidence. Existing runs are not silently certified.
ALTER TABLE reconcile_runs ADD COLUMN export_evidence_version INTEGER
    CHECK (export_evidence_version IS NULL OR export_evidence_version = 1);

CREATE FUNCTION protect_reconcile_published_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.export_evidence_version IS NOT NULL THEN
            RAISE EXCEPTION 'reconcile_evidence_version_is_server_assigned';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.export_evidence_version = 1 THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'reconcile_published_evidence_is_immutable';
        END IF;
        -- finalizeRun releases the operational lease after completing the run.
        IF NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
           AND (to_jsonb(NEW) - ARRAY['lease_owner', 'lease_expires_at'])
               = (to_jsonb(OLD) - ARRAY['lease_owner', 'lease_expires_at']) THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'reconcile_published_evidence_is_immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.export_evidence_version IS DISTINCT FROM OLD.export_evidence_version THEN
        RAISE EXCEPTION 'reconcile_evidence_version_is_server_assigned';
    END IF;
    IF OLD.status = 'RUNNING' AND NEW.status = 'COMPLETED' THEN
        NEW.export_evidence_version := 1;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reconcile_published_run_guard BEFORE INSERT OR UPDATE OR DELETE ON reconcile_runs
FOR EACH ROW EXECUTE FUNCTION protect_reconcile_published_run();

CREATE FUNCTION protect_reconcile_published_child() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    parent_version INTEGER;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        SELECT export_evidence_version INTO parent_version FROM public.reconcile_runs
        WHERE id = OLD.run_id AND run_key = OLD.run_key FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'reconcile_evidence_parent_mismatch'; END IF;
        IF parent_version = 1 THEN RAISE EXCEPTION 'reconcile_published_evidence_is_immutable'; END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        -- Serializes child writes with RUNNING -> COMPLETED publication.
        SELECT export_evidence_version INTO parent_version FROM public.reconcile_runs
        WHERE id = NEW.run_id AND run_key = NEW.run_key FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'reconcile_evidence_parent_mismatch'; END IF;
        IF parent_version = 1 THEN RAISE EXCEPTION 'reconcile_published_evidence_is_immutable'; END IF;
        RETURN NEW;
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER reconcile_published_child_guard BEFORE INSERT OR UPDATE OR DELETE ON reconcile_run_trades
FOR EACH ROW EXECUTE FUNCTION protect_reconcile_published_child();
CREATE TRIGGER reconcile_published_child_guard BEFORE INSERT OR UPDATE OR DELETE ON reconcile_drifts
FOR EACH ROW EXECUTE FUNCTION protect_reconcile_published_child();

CREATE FUNCTION reject_reconcile_evidence_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'reconcile_evidence_is_retained';
END;
$$;
CREATE TRIGGER reconcile_evidence_no_truncate BEFORE TRUNCATE ON reconcile_runs
FOR EACH STATEMENT EXECUTE FUNCTION reject_reconcile_evidence_truncate();
CREATE TRIGGER reconcile_evidence_no_truncate BEFORE TRUNCATE ON reconcile_run_trades
FOR EACH STATEMENT EXECUTE FUNCTION reject_reconcile_evidence_truncate();
CREATE TRIGGER reconcile_evidence_no_truncate BEFORE TRUNCATE ON reconcile_drifts
FOR EACH STATEMENT EXECUTE FUNCTION reject_reconcile_evidence_truncate();

-- Callable by the dedicated SELECT-only Treasury reader. No elevated privileges.
-- A missing or disabled guard makes export construction fail closed.
CREATE FUNCTION reconciliation_export_evidence_version() RETURNS INTEGER
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT CASE WHEN COUNT(*) = 6 THEN 1 ELSE NULL END
    FROM (VALUES
        ('reconcile_runs', 'reconcile_published_run_guard', 'protect_reconcile_published_run'),
        ('reconcile_run_trades', 'reconcile_published_child_guard', 'protect_reconcile_published_child'),
        ('reconcile_drifts', 'reconcile_published_child_guard', 'protect_reconcile_published_child'),
        ('reconcile_runs', 'reconcile_evidence_no_truncate', 'reject_reconcile_evidence_truncate'),
        ('reconcile_run_trades', 'reconcile_evidence_no_truncate', 'reject_reconcile_evidence_truncate'),
        ('reconcile_drifts', 'reconcile_evidence_no_truncate', 'reject_reconcile_evidence_truncate')
    ) AS expected(relation_name, trigger_name, function_name)
    JOIN pg_class c ON c.relname = expected.relation_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = expected.trigger_name
        AND t.tgenabled IN ('O', 'A') AND NOT t.tgisinternal
    JOIN pg_proc p ON p.oid = t.tgfoid AND p.proname = expected.function_name
        AND p.pronamespace = n.oid;
$$;
