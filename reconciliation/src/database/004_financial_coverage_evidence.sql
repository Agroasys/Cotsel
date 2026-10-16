-- Existing runs remain unproven for financial progression. No synthetic backfill.
ALTER TABLE reconcile_runs ADD COLUMN chain_evidence JSONB;
CREATE FUNCTION protect_reconcile_chain_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF OLD.chain_evidence IS NOT NULL AND NEW.chain_evidence IS DISTINCT FROM OLD.chain_evidence THEN
        RAISE EXCEPTION 'reconcile_chain_evidence_is_immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reconcile_chain_evidence_immutable BEFORE UPDATE ON reconcile_runs
FOR EACH ROW EXECUTE FUNCTION protect_reconcile_chain_evidence();
