-- SPDX-License-Identifier: Apache-2.0

-- Versioned settlement templates (Cotsel#940). A template is the canonical,
-- SHA-256-identified description of a settlement's terms
-- (@agroasys/sdk settlementTemplate). Versions move draft -> reviewed -> active
-- -> retired; review and activation need a person other than the author; terms
-- and hash never change once written; rows are never deleted. Every settlement
-- handoff records the template version it was created against.
SET LOCAL lock_timeout = '5s';

CREATE TABLE settlement_templates (
    template_id TEXT NOT NULL CHECK (template_id ~ '^[a-z][a-z0-9.-]{1,62}$'),
    version INTEGER NOT NULL CHECK (version >= 1),
    schema_version TEXT NOT NULL CHECK (schema_version = 'cotsel.settlement-template.v1'),
    template JSONB NOT NULL CHECK (jsonb_typeof(template) = 'object'),
    template_hash TEXT NOT NULL CHECK (template_hash ~ '^0x[0-9a-f]{64}$'),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'reviewed', 'active', 'retired')),
    created_by TEXT NOT NULL CHECK (length(created_by) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    activated_by TEXT,
    activated_at TIMESTAMPTZ,
    retired_by TEXT,
    retired_at TIMESTAMPTZ,
    request_id TEXT NOT NULL,
    PRIMARY KEY (template_id, version),
    UNIQUE (template_hash),
    CONSTRAINT settlement_templates_identity_matches CHECK (
        template->>'templateId' = template_id
        AND (template->>'version')::integer = version
        AND template->>'schemaVersion' = schema_version
    ),
    CONSTRAINT settlement_templates_reviewed_shape CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
    CONSTRAINT settlement_templates_activated_shape CHECK ((activated_by IS NULL) = (activated_at IS NULL)),
    CONSTRAINT settlement_templates_retired_shape CHECK ((retired_by IS NULL) = (retired_at IS NULL)),
    -- Two-person rule. The single bootstrap row written by this migration is the
    -- documented exception: it records terms the deployed contract already enforces.
    CONSTRAINT settlement_templates_independent_review CHECK (
        reviewed_by IS NULL OR reviewed_by <> created_by OR created_by = 'migration:017'
    ),
    CONSTRAINT settlement_templates_independent_activation CHECK (
        activated_by IS NULL OR activated_by <> created_by OR created_by = 'migration:017'
    ),
    CONSTRAINT settlement_templates_status_evidence CHECK (
        (status = 'draft' AND reviewed_by IS NULL AND activated_by IS NULL AND retired_by IS NULL)
        OR (status = 'reviewed' AND reviewed_by IS NOT NULL AND activated_by IS NULL AND retired_by IS NULL)
        OR (status = 'active' AND reviewed_by IS NOT NULL AND activated_by IS NOT NULL AND retired_by IS NULL)
        OR (status = 'retired' AND retired_by IS NOT NULL)
    )
);

-- At most one active version per template.
CREATE UNIQUE INDEX settlement_templates_one_active
    ON settlement_templates (template_id)
    WHERE status = 'active';

CREATE FUNCTION protect_settlement_template() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'settlement templates are never deleted'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.template_id IS DISTINCT FROM OLD.template_id
        OR NEW.version IS DISTINCT FROM OLD.version
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.template IS DISTINCT FROM OLD.template
        OR NEW.template_hash IS DISTINCT FROM OLD.template_hash
        OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.request_id IS DISTINCT FROM OLD.request_id
        -- Approval evidence is the actor and the time together: once recorded,
        -- neither changes.
        OR (OLD.reviewed_by IS NOT NULL AND NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by)
        OR (OLD.reviewed_at IS NOT NULL AND NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at)
        OR (OLD.activated_by IS NOT NULL AND NEW.activated_by IS DISTINCT FROM OLD.activated_by)
        OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
        OR (OLD.retired_by IS NOT NULL AND NEW.retired_by IS DISTINCT FROM OLD.retired_by)
        OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
        -- An empty pair is filled only by its own lifecycle transition.
        OR (OLD.reviewed_by IS NULL AND NEW.reviewed_by IS NOT NULL
            AND NOT (OLD.status = 'draft' AND NEW.status = 'reviewed'))
        OR (OLD.activated_by IS NULL AND NEW.activated_by IS NOT NULL
            AND NOT (OLD.status = 'reviewed' AND NEW.status = 'active'))
        OR (OLD.retired_by IS NULL AND NEW.retired_by IS NOT NULL
            AND NOT (OLD.status <> 'retired' AND NEW.status = 'retired'))
        OR (OLD.reviewed_by IS NULL AND NEW.reviewed_by = 'migration:017')
        OR (OLD.activated_by IS NULL AND NEW.activated_by = 'migration:017')
    THEN
        RAISE EXCEPTION 'settlement template % v% terms and evidence are immutable', OLD.template_id, OLD.version
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'draft' AND NEW.status IN ('reviewed', 'retired'))
        OR (OLD.status = 'reviewed' AND NEW.status IN ('active', 'retired'))
        OR (OLD.status = 'active' AND NEW.status = 'retired')
    ) THEN
        RAISE EXCEPTION 'settlement template % v% cannot move from % to %',
            OLD.template_id, OLD.version, OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_templates_protected
    BEFORE UPDATE OR DELETE ON settlement_templates
    FOR EACH ROW EXECUTE FUNCTION protect_settlement_template();

-- Template v1: the terms the deployed escrow enforces (LaunchSettlementSchedule
-- and the AgroasysEscrow window constants). The canonical JSON and hash equal
-- @agroasys/sdk AGROASYS_LAUNCH_TEMPLATE_V1 and settlementTemplateHash; a gateway
-- test fails if they ever differ.
INSERT INTO settlement_templates (
    template_id, version, schema_version, template, template_hash, status,
    created_by, reviewed_by, reviewed_at, activated_by, activated_at, request_id
) VALUES (
    'agroasys.launch',
    1,
    'cotsel.settlement-template.v1',
    '{"asset":{"decimals":6,"quantumBaseUnits":"10000","symbol":"USDC"},"fees":{"buyerBps":50,"fixedSupportFeeBaseUnits":"4000000","rounding":"half-up-per-quantum","supplierBps":50},"milestones":[{"deductsSupplierFee":true,"id":"stage1","releaseBps":6000},{"deductsSupplierFee":false,"id":"final","releaseBps":4000}],"schemaVersion":"cotsel.settlement-template.v1","templateId":"agroasys.launch","version":1,"windows":{"disputeProposalTtlSeconds":604800,"inTransitTimeoutSeconds":1209600,"lockTimeoutSeconds":604800,"packagedLocalInspectionSeconds":172800,"standardInspectionSeconds":259200}}'::jsonb,
    '0x842960db24429dfe92673a9e894e331edc9dd79b0dbaf957a6a18140a86b8070',
    'active',
    'migration:017',
    'migration:017',
    NOW(),
    'migration:017',
    NOW(),
    'migration:017'
);

-- Created after the seed, so the bootstrap row above is the only one that can
-- ever carry the migration:017 exemption. Every later version starts as a
-- plain draft and reaches active only through the guarded UPDATE path.
CREATE FUNCTION guard_new_settlement_template() RETURNS trigger AS $$
BEGIN
    IF NEW.status <> 'draft'
        OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL
        OR NEW.activated_by IS NOT NULL OR NEW.activated_at IS NOT NULL
        OR NEW.retired_by IS NOT NULL OR NEW.retired_at IS NOT NULL
    THEN
        RAISE EXCEPTION 'a new settlement template version must start as a draft'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.created_by = 'migration:017' THEN
        RAISE EXCEPTION 'migration:017 is reserved for the bootstrap template'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_templates_start_as_draft
    BEFORE INSERT ON settlement_templates
    FOR EACH ROW EXECUTE FUNCTION guard_new_settlement_template();

-- Every settlement records the terms it was created against. Existing handoffs
-- were created under v1, the only terms the contract has enforced. The columns
-- stay nullable so the previous gateway image keeps working after a rollback;
-- the current image refuses to create a handoff without them.
ALTER TABLE settlement_handoffs
    ADD COLUMN template_id TEXT,
    ADD COLUMN template_version INTEGER,
    ADD COLUMN template_hash TEXT;

-- settlement_handoffs forces row-level security; without the service name a
-- non-superuser migrator would see, and backfill, no rows at all.
SELECT set_config('app.service_name', 'gateway', true);

UPDATE settlement_handoffs
SET template_id = 'agroasys.launch',
    template_version = 1,
    template_hash = '0x842960db24429dfe92673a9e894e331edc9dd79b0dbaf957a6a18140a86b8070';

ALTER TABLE settlement_handoffs
    ADD CONSTRAINT settlement_handoffs_template_reference
        FOREIGN KEY (template_id, template_version)
        REFERENCES settlement_templates (template_id, version),
    ADD CONSTRAINT settlement_handoffs_template_complete CHECK (
        (template_id IS NULL) = (template_version IS NULL)
        AND (template_id IS NULL) = (template_hash IS NULL)
    );

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM settlement_handoffs WHERE template_id IS NULL) THEN
        RAISE EXCEPTION 'settlement handoff template backfill is incomplete';
    END IF;
END
$$;

DO $$
DECLARE
    runtime_user TEXT := NULLIF(current_setting('app.runtime_db_user', true), '');
BEGIN
    IF runtime_user IS NOT NULL THEN
        -- No DELETE: template versions are permanent evidence.
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON settlement_templates TO %I', runtime_user);
    END IF;
END
$$;

ALTER TABLE settlement_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY settlement_templates_service ON settlement_templates
    USING (current_app_service_name() = 'gateway')
    WITH CHECK (current_app_service_name() = 'gateway');
