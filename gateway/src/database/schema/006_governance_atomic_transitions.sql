-- SPDX-License-Identifier: Apache-2.0

-- Database-owned concurrency control for governance confirmation and monitoring.
-- These fields coordinate existing gateway replicas; they do not form an
-- executable governance queue and contain no signing authority or key material.
ALTER TABLE governance_actions
    ADD COLUMN IF NOT EXISTS transition_version BIGINT NOT NULL DEFAULT 0
        CHECK (transition_version >= 0),
    ADD COLUMN IF NOT EXISTS monitor_lease_owner TEXT,
    ADD COLUMN IF NOT EXISTS monitor_lease_token TEXT,
    ADD COLUMN IF NOT EXISTS monitor_lease_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_actions_transaction_hash
    ON governance_actions (LOWER(tx_hash))
    WHERE tx_hash IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'governance_actions_monitor_lease_complete'
          AND conrelid = 'governance_actions'::regclass
    ) THEN
        ALTER TABLE governance_actions
            ADD CONSTRAINT governance_actions_monitor_lease_complete
            CHECK (
                (
                    monitor_lease_owner IS NULL
                    AND monitor_lease_token IS NULL
                    AND monitor_lease_expires_at IS NULL
                ) OR (
                    monitor_lease_owner IS NOT NULL
                    AND monitor_lease_token IS NOT NULL
                    AND monitor_lease_expires_at IS NOT NULL
                    AND status IN ('broadcast_pending_verification', 'broadcast')
                )
            ) NOT VALID;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'governance_actions_monitor_lease_complete'
          AND conrelid = 'governance_actions'::regclass
          AND NOT convalidated
    ) THEN
        ALTER TABLE governance_actions
            VALIDATE CONSTRAINT governance_actions_monitor_lease_complete;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_governance_actions_monitor_claim
    ON governance_actions (
        COALESCE(monitor_lease_expires_at, updated_at) ASC,
        action_id ASC
    )
    WHERE status IN ('broadcast_pending_verification', 'broadcast');
