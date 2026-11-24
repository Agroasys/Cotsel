-- SPDX-License-Identifier: Apache-2.0
-- Human decisions stay in gateway custody; signed requests stay in reconciliation.
SET LOCAL lock_timeout = '5s';
CREATE TABLE reconciliation_freeze_reviews (
    request_id TEXT PRIMARY KEY CHECK (request_id ~ '^[a-f0-9]{64}$'),
    request JSONB NOT NULL CHECK (request->>'requestId' = request_id),
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    reviewed_by TEXT NOT NULL CHECK (length(reviewed_by) > 0),
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT NOT NULL CHECK (length(reason) > 0),
    ticket_ref TEXT NOT NULL,
    request_trace_id TEXT NOT NULL
);
CREATE FUNCTION protect_reconciliation_freeze_review() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'freeze review decisions are immutable' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reconciliation_freeze_reviews_immutable
    BEFORE UPDATE OR DELETE ON reconciliation_freeze_reviews
    FOR EACH ROW EXECUTE FUNCTION protect_reconciliation_freeze_review();
CREATE INDEX governance_actions_freeze_request
    ON governance_actions ((signer_policy_evidence->'reconciliationFreezeRequest'->'request'->>'requestId'))
    WHERE contract_method = 'pauseTrade';
DO $$
DECLARE runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT ON reconciliation_freeze_reviews TO %I', runtime_user);
    END IF;
END
$$;
ALTER TABLE reconciliation_freeze_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_freeze_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_freeze_reviews_service ON reconciliation_freeze_reviews
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');
