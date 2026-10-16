-- SPDX-License-Identifier: Apache-2.0

-- Durable administrator authority is granted and removed only through two-person
-- authority changes. One human principal proposes a change; a different principal
-- approves the exact proposal by its evidence digest, which applies it. A grant
-- is bound to one environment and expires; administrator authority holds only
-- while the latest applied change for the account and environment is an
-- unexpired grant. Existing `admin` profiles carry no applied grant and must be
-- proposed and approved before they confer authority again.
CREATE TABLE admin_authority_changes (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id             TEXT NOT NULL,
    change                 TEXT NOT NULL,
    environment            TEXT NOT NULL,
    org_id                 TEXT,
    grant_expires_at       TIMESTAMPTZ,
    resulting_role         TEXT NOT NULL,
    approval_ticket        TEXT NOT NULL,
    reason                 TEXT NOT NULL,
    evidence_digest        TEXT NOT NULL,
    state                  TEXT NOT NULL DEFAULT 'pending',
    proposed_by            TEXT NOT NULL,
    proposed_by_key        TEXT NOT NULL,
    proposed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_by             TEXT,
    applied_by_key         TEXT,
    applied_at             TIMESTAMPTZ,
    cancelled_by           TEXT,
    cancelled_at           TIMESTAMPTZ,
    cancelled_reason       TEXT,
    CONSTRAINT admin_authority_change_kind CHECK (
        (change = 'grant' AND resulting_role = 'admin' AND grant_expires_at IS NOT NULL)
        OR (
            change = 'revoke'
            AND resulting_role IN ('buyer', 'supplier')
            AND grant_expires_at IS NULL
            AND org_id IS NULL
        )
    ),
    CONSTRAINT admin_authority_change_environment
        CHECK (environment ~ '^[a-z][a-z0-9-]{0,31}$'),
    CONSTRAINT admin_authority_change_evidence_digest
        CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT admin_authority_change_human_principals CHECK (
        proposed_by ~ '^human:[a-z0-9][a-z0-9:._@/-]{0,127}$'
        AND (applied_by IS NULL OR applied_by ~ '^human:[a-z0-9][a-z0-9:._@/-]{0,127}$')
    ),
    CONSTRAINT admin_authority_change_distinct_approver
        CHECK (applied_by IS NULL OR applied_by <> proposed_by),
    CONSTRAINT admin_authority_change_lifecycle CHECK (
        (
            state = 'pending'
            AND applied_by IS NULL AND applied_by_key IS NULL AND applied_at IS NULL
            AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancelled_reason IS NULL
        ) OR (
            state = 'applied'
            AND applied_by IS NOT NULL AND applied_by_key IS NOT NULL AND applied_at IS NOT NULL
            AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancelled_reason IS NULL
        ) OR (
            state = 'cancelled'
            AND applied_by IS NULL AND applied_by_key IS NULL AND applied_at IS NULL
            AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
            AND cancelled_reason IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX idx_admin_authority_changes_one_pending
    ON admin_authority_changes(account_id, environment)
    WHERE state = 'pending';

CREATE INDEX idx_admin_authority_changes_applied
    ON admin_authority_changes(account_id, environment, applied_at DESC)
    WHERE state = 'applied';

-- Proposal evidence never changes, and only pending changes move.
CREATE FUNCTION prevent_admin_authority_change_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'admin authority changes cannot be deleted';
    END IF;
    IF OLD.state <> 'pending' THEN
        RAISE EXCEPTION 'applied or cancelled admin authority changes are immutable';
    END IF;
    IF OLD.account_id IS DISTINCT FROM NEW.account_id
       OR OLD.change IS DISTINCT FROM NEW.change
       OR OLD.environment IS DISTINCT FROM NEW.environment
       OR OLD.org_id IS DISTINCT FROM NEW.org_id
       OR OLD.grant_expires_at IS DISTINCT FROM NEW.grant_expires_at
       OR OLD.resulting_role IS DISTINCT FROM NEW.resulting_role
       OR OLD.approval_ticket IS DISTINCT FROM NEW.approval_ticket
       OR OLD.reason IS DISTINCT FROM NEW.reason
       OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
       OR OLD.proposed_by IS DISTINCT FROM NEW.proposed_by
       OR OLD.proposed_by_key IS DISTINCT FROM NEW.proposed_by_key
       OR OLD.proposed_at IS DISTINCT FROM NEW.proposed_at THEN
        RAISE EXCEPTION 'admin authority change proposal evidence is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER admin_authority_change_immutable
    BEFORE UPDATE OR DELETE ON admin_authority_changes
    FOR EACH ROW
    EXECUTE FUNCTION prevent_admin_authority_change_mutation();

ALTER TABLE admin_authority_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_authority_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_authority_changes_service_isolation ON admin_authority_changes
    FOR ALL
    USING (current_app_service_name() = 'auth')
    WITH CHECK (current_app_service_name() = 'auth');

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    REVOKE ALL ON TABLE admin_authority_changes FROM PUBLIC;
    IF runtime_user IS NOT NULL THEN
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE admin_authority_changes TO %I',
            runtime_user
        );
    END IF;
END $$;

ALTER TABLE auth_admin_audit_events
    DROP CONSTRAINT IF EXISTS auth_admin_audit_events_action_check;
ALTER TABLE auth_admin_audit_events
    ADD CONSTRAINT auth_admin_audit_events_action_check CHECK (action IN (
        'profile_provisioned', 'profile_role_updated', 'profile_deactivated',
        'break_glass_granted', 'break_glass_revoked', 'break_glass_expired',
        'break_glass_reviewed', 'operator_capabilities_updated',
        'signer_binding_provisioned', 'signer_binding_proposed',
        'signer_binding_activated', 'signer_binding_revoked',
        'admin_authority_change_proposed', 'admin_authority_change_applied',
        'admin_authority_change_cancelled'
    ));
