-- Bounded independent discovery, separate from the financial coverage cursor.
CREATE TABLE reconcile_enumeration_cycles (
    id UUID PRIMARY KEY,
    scope VARCHAR(64) NOT NULL,
    source_identity TEXT NOT NULL,
    anchor_block BIGINT NOT NULL CHECK (anchor_block >= 0),
    anchor_hash TEXT NOT NULL,
    chain_counter NUMERIC(78,0) NOT NULL CHECK (chain_counter >= 0),
    expected_count BIGINT NOT NULL CHECK (expected_count >= 0),
    start_cursor NUMERIC(78,0) NOT NULL CHECK (start_cursor >= 0),
    chain_cursor NUMERIC(78,0) NOT NULL CHECK (chain_cursor >= 0),
    CHECK (NOT coherent OR start_cursor=0),
    upper_id TEXT,
    after_id TEXT,
    walked BIGINT NOT NULL DEFAULT 0 CHECK (walked >= 0),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    exhausted BOOLEAN NOT NULL DEFAULT false,
    coherent BOOLEAN NOT NULL DEFAULT true,
    finished BOOLEAN NOT NULL DEFAULT false,
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX reconcile_enumeration_active ON reconcile_enumeration_cycles(scope) WHERE NOT finished;
CREATE TABLE reconcile_enumeration_members (
    cycle_id UUID NOT NULL REFERENCES reconcile_enumeration_cycles(id),
    physical_id TEXT NOT NULL,
    trade_id VARCHAR(255) NOT NULL,
    PRIMARY KEY (cycle_id, physical_id)
);
CREATE INDEX reconcile_enumeration_logical_identity ON reconcile_enumeration_members(cycle_id, trade_id);
ALTER TABLE reconcile_runs ADD COLUMN coverage_cycle_id UUID REFERENCES reconcile_enumeration_cycles(id);
CREATE INDEX reconcile_runs_coverage_cycle ON reconcile_runs(coverage_cycle_id, id);

DO $$
DECLARE runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON reconcile_enumeration_cycles TO %I', runtime_user);
        EXECUTE format('GRANT SELECT, INSERT ON reconcile_enumeration_members TO %I', runtime_user);
    END IF;
END $$;
ALTER TABLE reconcile_enumeration_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_enumeration_cycles FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_cycle_isolation ON reconcile_enumeration_cycles FOR ALL
USING (current_app_service_name()='reconciliation') WITH CHECK (current_app_service_name()='reconciliation');
ALTER TABLE reconcile_enumeration_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_enumeration_members FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_member_isolation ON reconcile_enumeration_members FOR ALL
USING (current_app_service_name()='reconciliation') WITH CHECK (current_app_service_name()='reconciliation');

-- Members are append-only retry evidence. Lifecycle cleanup requires custody review.
CREATE FUNCTION retain_reconcile_enumeration_members() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'reconcile_enumeration_members_are_retained'; END;
$$;
CREATE TRIGGER reconcile_enumeration_members_no_change BEFORE UPDATE OR DELETE ON reconcile_enumeration_members
FOR EACH ROW EXECUTE FUNCTION retain_reconcile_enumeration_members();
CREATE TRIGGER reconcile_enumeration_members_no_truncate BEFORE TRUNCATE ON reconcile_enumeration_members
FOR EACH STATEMENT EXECUTE FUNCTION retain_reconcile_enumeration_members();

CREATE FUNCTION protect_reconcile_enumeration_cycle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'DELETE' OR OLD.finished THEN
        RAISE EXCEPTION 'reconcile_enumeration_cycle_is_retained';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['after_id','walked','generation','exhausted','coherent','finished','updated_at','chain_cursor'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['after_id','walked','generation','exhausted','coherent','finished','updated_at','chain_cursor'])
       OR NEW.chain_cursor < OLD.chain_cursor OR NEW.generation <> OLD.generation + 1 OR NEW.walked < OLD.walked
       OR (OLD.exhausted AND NOT NEW.exhausted) OR (NOT OLD.coherent AND NEW.coherent)
       OR (OLD.after_id IS NOT NULL AND (NEW.after_id IS NULL OR NEW.after_id < OLD.after_id)) THEN
        RAISE EXCEPTION 'reconcile_enumeration_progress_is_invalid';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reconcile_enumeration_cycle_guard BEFORE UPDATE OR DELETE ON reconcile_enumeration_cycles
FOR EACH ROW EXECUTE FUNCTION protect_reconcile_enumeration_cycle();
CREATE TRIGGER reconcile_enumeration_cycles_no_truncate BEFORE TRUNCATE ON reconcile_enumeration_cycles
FOR EACH STATEMENT EXECUTE FUNCTION retain_reconcile_enumeration_members();

CREATE FUNCTION protect_reconcile_enumeration_member_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE cycle_finished BOOLEAN;
BEGIN
    SELECT finished INTO cycle_finished FROM public.reconcile_enumeration_cycles WHERE id=NEW.cycle_id FOR SHARE;
    IF NOT FOUND OR cycle_finished THEN RAISE EXCEPTION 'reconcile_enumeration_cycle_is_retained'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reconcile_enumeration_member_insert BEFORE INSERT ON reconcile_enumeration_members
FOR EACH ROW EXECUTE FUNCTION protect_reconcile_enumeration_member_insert();
