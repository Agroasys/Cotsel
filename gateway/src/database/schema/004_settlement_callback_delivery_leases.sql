ALTER TABLE settlement_callback_deliveries
    ADD COLUMN IF NOT EXISTS lease_owner TEXT;

ALTER TABLE settlement_callback_deliveries
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'settlement_callback_deliveries'
          AND column_name = 'next_attempt_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE settlement_callback_deliveries
            ALTER COLUMN next_attempt_at TYPE TIMESTAMPTZ
            USING next_attempt_at AT TIME ZONE 'UTC';
    END IF;
END
$$;

UPDATE settlement_callback_deliveries
SET status = 'failed',
    next_attempt_at = LEAST(next_attempt_at, NOW()),
    last_error = COALESCE(last_error, 'Recovered callback without a valid delivery lease'),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = NOW()
WHERE status = 'delivering'
  AND (lease_owner IS NULL OR lease_expires_at IS NULL);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'settlement_callback_deliveries_lease_check'
          AND conrelid = 'settlement_callback_deliveries'::regclass
    ) THEN
        ALTER TABLE settlement_callback_deliveries
            ADD CONSTRAINT settlement_callback_deliveries_lease_check
            CHECK (
                (status = 'delivering' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
                OR (status <> 'delivering' AND lease_owner IS NULL AND lease_expires_at IS NULL)
            ) NOT VALID;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'settlement_callback_deliveries_lease_check'
          AND conrelid = 'settlement_callback_deliveries'::regclass
          AND NOT convalidated
    ) THEN
        ALTER TABLE settlement_callback_deliveries
            VALIDATE CONSTRAINT settlement_callback_deliveries_lease_check;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_settlement_callback_deliveries_due_lease
    ON settlement_callback_deliveries(
        COALESCE(lease_expires_at, next_attempt_at) ASC,
        created_at ASC
    )
    WHERE status IN ('pending', 'failed', 'delivering');
