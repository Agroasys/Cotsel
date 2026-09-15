-- SPDX-License-Identifier: Apache-2.0

-- Convert signer registration into a two-person lifecycle. Existing bindings
-- were activated from operator-supplied approval text and cannot be attributed
-- to canonical human principals. They are retained as revoked history and must
-- be reproposed before they can authorize a session.
DROP TRIGGER IF EXISTS operator_signer_binding_evidence_immutable
    ON operator_signer_bindings;

ALTER TABLE operator_signer_bindings
    ALTER COLUMN approving_authority DROP NOT NULL,
    ALTER COLUMN approved_at DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS state TEXT,
    ADD COLUMN IF NOT EXISTS evidence_digest TEXT,
    ADD COLUMN IF NOT EXISTS approved_by_principal TEXT,
    ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS approved_digest TEXT,
    ADD COLUMN IF NOT EXISTS legacy_approval_claim JSONB;

ALTER TABLE operator_signer_bindings
    DROP CONSTRAINT IF EXISTS operator_signer_binding_revocation_complete;
ALTER TABLE operator_signer_bindings
    DROP CONSTRAINT IF EXISTS operator_signer_binding_approval_not_future;

UPDATE operator_signer_bindings
SET state = 'revoked',
    active = FALSE,
    evidence_digest = encode(
        digest(
            convert_to(
                jsonb_build_array(
                    'v1', account_id, wallet_address, action_class, environment,
                    custodian_name, approval_ticket, notes,
                    CASE
                        WHEN created_by LIKE 'service_auth:%' THEN created_by
                        ELSE 'service_auth:' || created_by
                    END
                )::text,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    ),
    approved_by_principal = NULL,
    activated_at = NULL,
    approved_digest = NULL,
    created_by = CASE
        WHEN created_by LIKE 'service_auth:%' THEN created_by
        ELSE 'service_auth:' || created_by
    END,
    legacy_approval_claim = jsonb_build_object(
        'approvingAuthority', approving_authority,
        'approvedAt', approved_at,
        'migratedAs', CASE
            WHEN active THEN 'canonical_human_reproposal_required'
            ELSE 'revoked_history'
        END
    ),
    revoked_at = COALESCE(revoked_at, updated_at, NOW()),
    revoked_by = COALESCE(revoked_by, 'auth:migration'),
    revoked_reason = COALESCE(revoked_reason, 'canonical_human_reproposal_required'),
    updated_at = NOW()
WHERE state IS NULL;

ALTER TABLE operator_signer_bindings
    ALTER COLUMN state SET NOT NULL,
    ALTER COLUMN evidence_digest SET NOT NULL,
    ADD CONSTRAINT operator_signer_binding_state_check
        CHECK (state IN ('pending', 'active', 'revoked')),
    ADD CONSTRAINT operator_signer_binding_evidence_digest_check
        CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT operator_signer_binding_approval_digest_check
        CHECK (approved_digest IS NULL OR approved_digest ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT operator_signer_binding_distinct_approver
        CHECK (approved_by_principal IS NULL OR approved_by_principal <> created_by),
    ADD CONSTRAINT operator_signer_binding_human_principals CHECK (
        state = 'revoked' OR (
            created_by ~ '^human:[a-z0-9][a-z0-9:._@/-]{0,127}$'
            AND (
                approved_by_principal IS NULL
                OR approved_by_principal ~ '^human:[a-z0-9][a-z0-9:._@/-]{0,127}$'
            )
        )
    );

ALTER TABLE operator_signer_bindings
    ADD CONSTRAINT operator_signer_binding_lifecycle_complete CHECK (
        (
            state = 'pending'
            AND active = FALSE
            AND approved_by_principal IS NULL
            AND activated_at IS NULL
            AND approved_digest IS NULL
            AND revoked_at IS NULL
            AND revoked_by IS NULL
            AND revoked_reason IS NULL
        ) OR (
            state = 'active'
            AND active = TRUE
            AND approved_by_principal IS NOT NULL
            AND approving_authority IS NOT NULL
            AND approving_authority = approved_by_principal
            AND approved_at IS NOT NULL
            AND activated_at IS NOT NULL
            AND approved_at = activated_at
            AND approved_digest IS NOT NULL
            AND approved_digest = evidence_digest
            AND revoked_at IS NULL
            AND revoked_by IS NULL
            AND revoked_reason IS NULL
        ) OR (
            state = 'revoked'
            AND active = FALSE
            AND revoked_at IS NOT NULL
            AND revoked_by IS NOT NULL
            AND revoked_reason IS NOT NULL
        )
    );

DROP INDEX IF EXISTS idx_operator_signer_bindings_active_wallet_scope;
CREATE UNIQUE INDEX idx_operator_signer_bindings_open_wallet_scope
    ON operator_signer_bindings(wallet_address, action_class, environment)
    WHERE state IN ('pending', 'active');

CREATE OR REPLACE FUNCTION prevent_operator_signer_binding_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'revoked operator signer bindings are immutable';
    END IF;

    IF OLD.account_id IS DISTINCT FROM NEW.account_id
       OR OLD.wallet_address IS DISTINCT FROM NEW.wallet_address
       OR OLD.action_class IS DISTINCT FROM NEW.action_class
       OR OLD.environment IS DISTINCT FROM NEW.environment
       OR OLD.custodian_name IS DISTINCT FROM NEW.custodian_name
       OR OLD.approval_ticket IS DISTINCT FROM NEW.approval_ticket
       OR OLD.notes IS DISTINCT FROM NEW.notes
       OR OLD.created_by IS DISTINCT FROM NEW.created_by
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
       OR OLD.legacy_approval_claim IS DISTINCT FROM NEW.legacy_approval_claim THEN
        RAISE EXCEPTION 'operator signer proposal evidence is immutable';
    END IF;

    IF OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'active', 'revoked') THEN
        RAISE EXCEPTION 'invalid pending signer binding transition';
    END IF;
    IF OLD.state = 'active' AND NEW.state NOT IN ('active', 'revoked') THEN
        RAISE EXCEPTION 'invalid active signer binding transition';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER operator_signer_binding_evidence_immutable
    BEFORE UPDATE ON operator_signer_bindings
    FOR EACH ROW
    EXECUTE FUNCTION prevent_operator_signer_binding_evidence_mutation();

CREATE OR REPLACE FUNCTION revoke_signer_bindings_without_admin_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (OLD.role = 'admin' AND NEW.role <> 'admin')
       OR (OLD.active = TRUE AND NEW.active = FALSE) THEN
        UPDATE operator_signer_bindings
        SET state = 'revoked',
            active = FALSE,
            revoked_at = NOW(),
            revoked_by = 'auth:profile-authority-trigger',
            revoked_reason = 'profile_authority_removed',
            updated_at = NOW()
        WHERE account_id = NEW.account_id
          AND state IN ('pending', 'active');
    END IF;

    RETURN NEW;
END;
$$;

ALTER TABLE auth_admin_audit_events
    DROP CONSTRAINT IF EXISTS auth_admin_audit_events_action_check;
ALTER TABLE auth_admin_audit_events
    ADD CONSTRAINT auth_admin_audit_events_action_check CHECK (action IN (
        'profile_provisioned', 'profile_role_updated', 'profile_deactivated',
        'break_glass_granted', 'break_glass_revoked', 'break_glass_expired',
        'break_glass_reviewed', 'operator_capabilities_updated',
        'signer_binding_provisioned', 'signer_binding_proposed',
        'signer_binding_activated', 'signer_binding_revoked'
    ));
