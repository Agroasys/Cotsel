-- WP-4 H-15 / H-16: an immutable actor chain for treasury maker-checker control.
--
-- Separation of duty was decided from the mutable `*_by` columns on
-- `sweep_batches`. Those columns only ever hold the latest actor for each role,
-- so a batch that returned to DRAFT and was re-requested by a second maker
-- forgot the first one, and the original maker could then approve their own
-- batch. Two concurrent transitions could also overwrite each other's actor,
-- leaving a chain that never happened.
--
-- This table records every accepted transition once. It is append-only, so the
-- decision history behind a settled batch or a closed accounting period stays
-- reproducible, and separation of duty is evaluated against the whole chain
-- rather than the last writer.

CREATE TABLE IF NOT EXISTS treasury_transition_actors (
    id SERIAL PRIMARY KEY,
    subject_type VARCHAR(32) NOT NULL
        CHECK (subject_type IN ('SWEEP_BATCH', 'ACCOUNTING_PERIOD')),
    subject_id INT NOT NULL,
    from_status VARCHAR(32) NOT NULL,
    to_status VARCHAR(32) NOT NULL,
    actor VARCHAR(255) NOT NULL CHECK (length(trim(actor)) > 0),
    actor_role VARCHAR(32) NOT NULL
        CHECK (actor_role IN ('MAKER', 'CHECKER', 'EXECUTOR', 'CLOSER')),
    recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE treasury_transition_actors IS
    'Append-only record of every accepted treasury maker-checker transition and the authenticated actor that made it.';

-- Evidence that can be edited is not evidence. The runtime role is granted only
-- SELECT and INSERT, and the trigger keeps the guarantee for any other writer
-- that reaches the table, including a manual repair session.
CREATE OR REPLACE FUNCTION treasury_transition_actors_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'treasury_transition_actors is append-only; % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS treasury_transition_actors_immutable ON treasury_transition_actors;
CREATE TRIGGER treasury_transition_actors_immutable
    BEFORE UPDATE OR DELETE ON treasury_transition_actors
    FOR EACH ROW
    EXECUTE FUNCTION treasury_transition_actors_append_only();

-- Every separation-of-duty decision reads one subject's chain in order.
CREATE INDEX IF NOT EXISTS idx_treasury_transition_actors_subject
    ON treasury_transition_actors(subject_type, subject_id, id);

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE treasury_transition_actors TO %I', runtime_user);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE treasury_transition_actors_id_seq TO %I', runtime_user);
    END IF;
END $$;

ALTER TABLE treasury_transition_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_transition_actors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS treasury_transition_actors_service_isolation ON treasury_transition_actors;
CREATE POLICY treasury_transition_actors_service_isolation ON treasury_transition_actors
    FOR ALL
    USING (current_app_service_name() = 'treasury')
    WITH CHECK (current_app_service_name() = 'treasury');

-- Backfill the chain from the actor columns that already exist so an upgraded
-- deployment evaluates separation of duty against its real history instead of
-- an empty chain. Only transitions the columns can attribute are recorded.
INSERT INTO treasury_transition_actors (subject_type, subject_id, from_status, to_status, actor, actor_role, recorded_at, metadata)
SELECT 'SWEEP_BATCH', id, 'DRAFT', 'PENDING_APPROVAL', approval_requested_by, 'MAKER',
       COALESCE(approval_requested_at, created_at), '{"backfilled": true}'::jsonb
FROM sweep_batches
WHERE approval_requested_by IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM treasury_transition_actors existing
      WHERE existing.subject_type = 'SWEEP_BATCH' AND existing.subject_id = sweep_batches.id
  );

INSERT INTO treasury_transition_actors (subject_type, subject_id, from_status, to_status, actor, actor_role, recorded_at, metadata)
SELECT 'SWEEP_BATCH', id, 'PENDING_APPROVAL', 'APPROVED', approved_by, 'CHECKER',
       COALESCE(approved_at, created_at), '{"backfilled": true}'::jsonb
FROM sweep_batches
WHERE approved_by IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM treasury_transition_actors existing
      WHERE existing.subject_type = 'SWEEP_BATCH' AND existing.subject_id = sweep_batches.id
        AND existing.to_status = 'APPROVED'
  );

INSERT INTO treasury_transition_actors (subject_type, subject_id, from_status, to_status, actor, actor_role, recorded_at, metadata)
SELECT 'SWEEP_BATCH', id, 'APPROVED', 'EXECUTED', executed_by, 'EXECUTOR',
       COALESCE(matched_swept_at, created_at), '{"backfilled": true}'::jsonb
FROM sweep_batches
WHERE executed_by IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM treasury_transition_actors existing
      WHERE existing.subject_type = 'SWEEP_BATCH' AND existing.subject_id = sweep_batches.id
        AND existing.to_status = 'EXECUTED'
  );

INSERT INTO treasury_transition_actors (subject_type, subject_id, from_status, to_status, actor, actor_role, recorded_at, metadata)
SELECT 'SWEEP_BATCH', id, 'HANDED_OFF', 'CLOSED', closed_by, 'CLOSER',
       COALESCE(closed_at, created_at), '{"backfilled": true}'::jsonb
FROM sweep_batches
WHERE closed_by IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM treasury_transition_actors existing
      WHERE existing.subject_type = 'SWEEP_BATCH' AND existing.subject_id = sweep_batches.id
        AND existing.to_status = 'CLOSED'
  );

INSERT INTO treasury_transition_actors (subject_type, subject_id, from_status, to_status, actor, actor_role, recorded_at, metadata)
SELECT 'ACCOUNTING_PERIOD', id, 'PENDING_CLOSE', 'CLOSED', closed_by, 'CHECKER',
       COALESCE(closed_at, created_at), '{"backfilled": true}'::jsonb
FROM accounting_periods
WHERE closed_by IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM treasury_transition_actors existing
      WHERE existing.subject_type = 'ACCOUNTING_PERIOD' AND existing.subject_id = accounting_periods.id
        AND existing.to_status = 'CLOSED'
  );
