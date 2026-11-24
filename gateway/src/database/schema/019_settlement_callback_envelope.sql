-- SPDX-License-Identifier: Apache-2.0
-- Nullable for historical rows and images from before envelope publication.
SET LOCAL lock_timeout = '5s';

ALTER TABLE settlement_callback_deliveries ADD COLUMN envelope JSONB;
ALTER TABLE settlement_callback_deliveries
    ADD CONSTRAINT settlement_callback_envelope_shape CHECK (
        envelope IS NULL OR (
            jsonb_typeof(envelope) = 'object'
            AND envelope ?& ARRAY['eventId', 'type', 'schemaVersion', 'producer', 'settlementId', 'orderingKey', 'occurredAt', 'payload']
            AND envelope->>'eventId' = event_id
            AND envelope->>'type' = 'cotsel.settlement-callback'
            AND envelope->>'schemaVersion' = 'v1'
            AND envelope->>'producer' = 'gateway'
        )
    );

CREATE FUNCTION protect_settlement_callback_envelope() RETURNS trigger AS $$
BEGIN
    IF OLD.envelope IS NOT NULL AND NEW.envelope IS DISTINCT FROM OLD.envelope THEN
        RAISE EXCEPTION 'settlement callback envelope is immutable once written'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_callback_envelope_immutable
    BEFORE UPDATE OF envelope ON settlement_callback_deliveries
    FOR EACH ROW EXECUTE FUNCTION protect_settlement_callback_envelope();
