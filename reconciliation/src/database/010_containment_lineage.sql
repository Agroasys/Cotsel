-- SPDX-License-Identifier: Apache-2.0

-- Containment evidence lineage and incident episodes (Cotsel#951, review R01/R03).
--
-- cited_findings: every finding the current incident cites, each as
--   {"runKey": ..., "digest": ...} naming the signed run it was found in. A
--   repeat sighting appends; nothing is replaced, so a verifier can check each
--   digest against its own run's signed manifest.
-- episode: one row per trade survives release; a divergence after release is
--   a new incident (new reference, opening run and lineage) and bumps this.
SET LOCAL lock_timeout = '5s';

ALTER TABLE reconcile_trade_containments
    ADD COLUMN cited_findings JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(cited_findings) = 'array'),
    ADD COLUMN episode INTEGER NOT NULL DEFAULT 1 CHECK (episode >= 1);

-- Under forced row-level security a non-superuser migrator sees no rows unless
-- the service name is set; set it for this transaction only, so the backfill
-- below reaches every row (the gateway 017 backfill has the same guard).
SELECT set_config('app.service_name', 'reconciliation', true);

-- Existing rows: their evidence lists the findings of the run that last saw them.
UPDATE reconcile_trade_containments
SET cited_findings = COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'runKey', COALESCE(last_observed_run_key, opened_run_key),
            'digest', finding->>'digest'))
        FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(evidence->'findings') = 'array'
                 THEN evidence->'findings' ELSE '[]'::jsonb END) AS finding
        WHERE finding ? 'digest'
    ), '[]'::jsonb);
