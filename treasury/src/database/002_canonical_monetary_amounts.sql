-- WP-4 H-24: canonical monetary types and allocation invariants.
--
-- Treasury stores two different kinds of money and they must not share one
-- constraint:
--
--   * `*_raw` columns hold the exact uint256 the escrow emitted, a scaled
--     integer in the asset's smallest unit.
--   * partner and fiat-ramp columns hold a provider-reported amount paired with
--     a currency code (`source_currency`, `expected_currency`), which is a
--     decimal quantity such as '125.00' USD.
--
-- Every one of these columns was unconstrained TEXT, so '', '-1', '1e6',
-- ' 100 ' and '007' were all storable and were cast with `::numeric` at read
-- time. The two domains below make the canonical spelling the only
-- representable one for each kind, and the trigger stops a sweep claiming more
-- than the ledger entry it draws from.

CREATE DOMAIN treasury_raw_amount AS TEXT
    CONSTRAINT treasury_raw_amount_is_canonical CHECK (
        VALUE ~ '^(0|[1-9][0-9]*)$'
        AND length(VALUE) <= 78
        AND VALUE::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
    );

COMMENT ON DOMAIN treasury_raw_amount IS
    'Unsigned uint256 scaled integer in the asset smallest unit, canonical decimal spelling only.';

CREATE DOMAIN treasury_fiat_amount AS TEXT
    CONSTRAINT treasury_fiat_amount_is_canonical CHECK (
        VALUE ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$'
        AND length(VALUE) <= 40
    );

COMMENT ON DOMAIN treasury_fiat_amount IS
    'Unsigned fixed-point provider amount, canonical spelling, at most 8 fractional digits. Always paired with a currency column.';

-- Each ALTER validates every existing row. A non-canonical legacy value fails
-- the migration rather than being silently rewritten: a value nobody can
-- attribute is an accounting question, not a data-cleanup task.
ALTER TABLE treasury_ledger_entries
    ALTER COLUMN amount_raw TYPE treasury_raw_amount;

ALTER TABLE sweep_batches
    ALTER COLUMN expected_total_raw TYPE treasury_raw_amount;

ALTER TABLE sweep_batch_entries
    ALTER COLUMN entry_amount_raw TYPE treasury_raw_amount;

ALTER TABLE treasury_claim_events
    ALTER COLUMN amount_raw TYPE treasury_raw_amount;

ALTER TABLE fiat_deposit_references
    ALTER COLUMN source_amount TYPE treasury_fiat_amount,
    ALTER COLUMN expected_amount TYPE treasury_fiat_amount;

ALTER TABLE fiat_deposit_events
    ALTER COLUMN source_amount TYPE treasury_fiat_amount,
    ALTER COLUMN expected_amount TYPE treasury_fiat_amount;

ALTER TABLE treasury_partner_handoffs
    ALTER COLUMN source_amount TYPE treasury_fiat_amount,
    ALTER COLUMN destination_amount TYPE treasury_fiat_amount;

-- An allocation may be partial, but it can never exceed the ledger entry it
-- draws from, and a zero allocation is never meaningful. The application
-- enforces this inside its allocation transaction; the trigger makes the
-- invariant hold for any writer, including a manual repair session.
CREATE OR REPLACE FUNCTION treasury_assert_allocation_within_ledger_amount()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    ledger_amount treasury_raw_amount;
BEGIN
    IF NEW.allocation_status <> 'ALLOCATED' THEN
        RETURN NEW;
    END IF;

    SELECT amount_raw
      INTO ledger_amount
      FROM treasury_ledger_entries
     WHERE id = NEW.ledger_entry_id;

    IF ledger_amount IS NULL THEN
        RAISE EXCEPTION
            'Sweep allocation references missing ledger entry %', NEW.ledger_entry_id;
    END IF;

    IF NEW.entry_amount_raw::numeric = 0 THEN
        RAISE EXCEPTION
            'Sweep allocation for ledger entry % must be greater than zero',
            NEW.ledger_entry_id;
    END IF;

    IF NEW.entry_amount_raw::numeric > ledger_amount::numeric THEN
        RAISE EXCEPTION
            'Sweep allocation % exceeds the eligible ledger amount % for entry %',
            NEW.entry_amount_raw, ledger_amount, NEW.ledger_entry_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sweep_batch_entries_allocation_bound ON sweep_batch_entries;
CREATE TRIGGER sweep_batch_entries_allocation_bound
    BEFORE INSERT OR UPDATE ON sweep_batch_entries
    FOR EACH ROW
    EXECUTE FUNCTION treasury_assert_allocation_within_ledger_amount();

-- The export pages on (created_at DESC, id DESC) under a fixed cutoff. Without
-- a matching index every page degrades into a full scan as the ledger grows.
CREATE INDEX IF NOT EXISTS idx_treasury_ledger_export_keyset
    ON treasury_ledger_entries(created_at DESC, id DESC);
