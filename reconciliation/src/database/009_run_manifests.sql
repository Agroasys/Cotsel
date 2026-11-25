-- Signed run manifests (Cotsel#951). One row seals one completed run: the
-- canonical manifest (finding digests, scope digest, coverage and completion
-- fields), its ECDSA P-256 signature and the signing key id. Verification is in
-- @agroasys/shared-db/reconciliationEvidence. A manifest is written only while
-- its run is being completed, in the same transaction, and never changes.

-- Check before the first signing migration can change the schema or ledger.
-- Existing open incidents predate the signing boundary. Only the legacy
-- governed process can close them. The cutover requires drained writers.
SET LOCAL lock_timeout = '5s';
SELECT set_config('app.service_name', 'reconciliation', true);
LOCK TABLE public.reconcile_trade_containments IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.reconcile_trade_containments
        WHERE state IN ('CONTAINED', 'RECONCILED_PENDING_APPROVAL')
    ) THEN
        RAISE EXCEPTION 'reconciliation_signed_cutover_open_legacy_containment'
            USING ERRCODE = 'check_violation',
                  HINT = 'Resolve open incidents through the legacy governed procedure before signed-evidence cutover.';
    END IF;
END;
$$;

CREATE TABLE reconcile_run_manifests (
    run_key VARCHAR(255) PRIMARY KEY REFERENCES reconcile_runs(run_key) ON DELETE RESTRICT,
    schema_version TEXT NOT NULL CHECK (schema_version = 'cotsel.reconciliation-run-manifest.v1'),
    manifest JSONB NOT NULL CHECK (
        jsonb_typeof(manifest) = 'object'
        AND manifest->>'runKey' = run_key
        AND manifest->>'schemaVersion' = schema_version
        AND manifest->>'keyId' = key_id
    ),
    signature TEXT NOT NULL CHECK (signature ~ '^[A-Za-z0-9+/]+={0,2}$'),
    key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 2048),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION protect_reconcile_run_manifest() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    run_status TEXT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'reconcile_run_manifest_is_immutable';
    END IF;
    -- The run row is locked by finalizeRun; a manifest cannot be attached to a
    -- run that was published earlier, nor to one that is not completed.
    SELECT status INTO run_status FROM public.reconcile_runs WHERE run_key = NEW.run_key;
    IF run_status IS DISTINCT FROM 'COMPLETED' THEN
        RAISE EXCEPTION 'reconcile_run_manifest_requires_completed_run';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.reconcile_runs
        WHERE run_key = NEW.run_key AND xmin = pg_catalog.pg_current_xact_id()::xid
    ) THEN
        RAISE EXCEPTION 'reconcile_run_manifest_must_seal_in_completing_transaction';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reconcile_run_manifest_guard
BEFORE INSERT OR UPDATE OR DELETE ON reconcile_run_manifests
FOR EACH ROW EXECUTE FUNCTION protect_reconcile_run_manifest();

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE reconcile_run_manifests TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE reconcile_run_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_run_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY reconcile_run_manifests_service_isolation ON reconcile_run_manifests
    FOR ALL
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');
