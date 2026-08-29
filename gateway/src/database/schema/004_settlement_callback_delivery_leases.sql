ALTER TABLE settlement_callback_deliveries
    ADD COLUMN IF NOT EXISTS lease_owner TEXT;

ALTER TABLE settlement_callback_deliveries
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP;

UPDATE settlement_callback_deliveries
SET status = 'failed',
    next_attempt_at = LEAST(next_attempt_at, NOW()),
    last_error = COALESCE(last_error, 'Recovered callback without a valid delivery lease'),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = NOW()
WHERE status = 'delivering'
  AND (lease_owner IS NULL OR lease_expires_at IS NULL);

ALTER TABLE settlement_callback_deliveries
    DROP CONSTRAINT IF EXISTS settlement_callback_deliveries_lease_check;
ALTER TABLE settlement_callback_deliveries
    ADD CONSTRAINT settlement_callback_deliveries_lease_check
    CHECK (
        (status = 'delivering' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'delivering' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    );

CREATE INDEX IF NOT EXISTS idx_settlement_callback_deliveries_due_lease
    ON settlement_callback_deliveries(
        COALESCE(lease_expires_at, next_attempt_at) ASC,
        created_at ASC
    )
    WHERE status IN ('pending', 'failed', 'delivering');
