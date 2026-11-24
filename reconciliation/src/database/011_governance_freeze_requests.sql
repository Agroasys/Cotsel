-- SPDX-License-Identifier: Apache-2.0
-- Durable requests carry signed finding references; reconciliation never executes them.
SET LOCAL lock_timeout = '5s';
SELECT set_config('app.service_name', 'reconciliation', true);

-- A clean observation can replace last_observed_run_key. Resolve legacy digests
-- against their actual signed manifest instead of incorrectly using that observation.
UPDATE reconcile_trade_containments c SET cited_findings = COALESCE((
    SELECT jsonb_agg(jsonb_build_object('runKey', m.run_key, 'digest', source.digest)
                     ORDER BY m.run_key, source.digest)
    FROM (
        SELECT DISTINCT item->>'digest' AS digest
        FROM jsonb_array_elements(c.cited_findings ||
          CASE WHEN jsonb_typeof(c.evidence->'findings') = 'array'
               THEN c.evidence->'findings' ELSE '[]'::jsonb END) item
        WHERE item ? 'digest'
    ) source
    JOIN reconcile_run_manifests m ON (m.manifest->'findings'->'digests') ? source.digest
), '[]'::jsonb);

CREATE TABLE reconcile_governance_freeze_requests (
    request_id TEXT PRIMARY KEY CHECK (request_id ~ '^[a-f0-9]{64}$'),
    run_key VARCHAR(255) NOT NULL REFERENCES reconcile_run_manifests(run_key),
    trade_id TEXT NOT NULL,
    incident_reference TEXT NOT NULL,
    episode INTEGER NOT NULL CHECK (episode > 0),
    request JSONB NOT NULL CHECK (
        jsonb_typeof(request) = 'object'
        AND request ?& ARRAY['schemaVersion', 'requestId', 'runKey', 'tradeId', 'requiresGovernanceApproval', 'findings']
        AND request->>'schemaVersion' = 'cotsel.governance-freeze-request.v1'
        AND request->>'requestId' = request_id AND request->>'runKey' = run_key
        AND request->>'tradeId' = trade_id AND request->>'requiresGovernanceApproval' = 'true'
        AND request->>'incidentReference' = incident_reference
        AND (request->>'episode')::integer = episode
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(trade_id, incident_reference, episode)
);
CREATE FUNCTION protect_reconcile_freeze_request() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'governance freeze requests are immutable' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reconcile_governance_freeze_requests_immutable
    BEFORE UPDATE OR DELETE ON reconcile_governance_freeze_requests
    FOR EACH ROW EXECUTE FUNCTION protect_reconcile_freeze_request();
DO $$
DECLARE runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT ON reconcile_governance_freeze_requests TO %I', runtime_user);
    END IF;
END
$$;
ALTER TABLE reconcile_governance_freeze_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_governance_freeze_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY reconcile_governance_freeze_requests_service ON reconcile_governance_freeze_requests
    USING (current_app_service_name() = 'reconciliation')
    WITH CHECK (current_app_service_name() = 'reconciliation');
