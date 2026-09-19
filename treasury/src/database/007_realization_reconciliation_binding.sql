-- WP-4 H-25: bind revenue realization to the exact reconciliation watermark.
--
-- Realization required a completed external handoff and a confirmed bank
-- payout, and the eligibility read beside it required a reconciliation run that
-- was recent and drift-free. None of that established that the run had actually
-- *reached* the entry being realized. A run is evidence about the block range it
-- covered and nothing else, so a fresh, clean run that stopped below an entry
-- said nothing whatsoever about that entry -- and the realization record kept
-- no trace of which run it had relied on, so the gap could not be found
-- afterwards either.
--
-- The realization row now names the run and the block, and the constraint keeps
-- the two from drifting apart: a realization that cites a run must also say how
-- far that run reached, and that watermark must not be below the entry's own
-- block.

ALTER TABLE revenue_realizations
    ADD COLUMN IF NOT EXISTS reconciliation_run_key VARCHAR(255),
    ADD COLUMN IF NOT EXISTS reconciliation_coverage_to_block BIGINT
        CHECK (reconciliation_coverage_to_block >= 0),
    ADD COLUMN IF NOT EXISTS entry_block_number BIGINT
        CHECK (entry_block_number >= 0);

COMMENT ON COLUMN revenue_realizations.reconciliation_run_key IS
    'The exact reconciliation run this realization was cleared against. NULL identifies a realization recorded before WP-4 H-25 and is not evidence of coverage.';
COMMENT ON COLUMN revenue_realizations.reconciliation_coverage_to_block IS
    'The chain watermark that run reached. Realization requires the entry block to be at or below it; a run that stopped short proves nothing about this entry.';
COMMENT ON COLUMN revenue_realizations.entry_block_number IS
    'The ledger entry block the watermark is compared against, stored so the comparison can be re-checked without re-deriving it.';

-- Nullable, because rows written before this control exist and cannot be
-- retrofitted with evidence nobody recorded. What the constraint does refuse is
-- a *partial* claim: citing a run without saying how far it reached, or citing
-- a watermark that is below the block it is supposed to cover. Those would read
-- as binding evidence while proving nothing.
ALTER TABLE revenue_realizations
    DROP CONSTRAINT IF EXISTS revenue_realizations_reconciliation_binding_complete;
ALTER TABLE revenue_realizations
    ADD CONSTRAINT revenue_realizations_reconciliation_binding_complete CHECK (
        (reconciliation_run_key IS NULL
            AND reconciliation_coverage_to_block IS NULL
            AND entry_block_number IS NULL)
        OR (reconciliation_run_key IS NOT NULL
            AND reconciliation_coverage_to_block IS NOT NULL
            AND entry_block_number IS NOT NULL
            AND entry_block_number <= reconciliation_coverage_to_block)
    );

CREATE INDEX IF NOT EXISTS idx_revenue_realizations_reconciliation_run
    ON revenue_realizations(reconciliation_run_key);
