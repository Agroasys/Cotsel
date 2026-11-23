-- SPDX-License-Identifier: Apache-2.0

-- Store the registered event envelope with every outbox row (Cotsel#949,
-- docs/api/events/envelope.v1.schema.json), so relays and consumers read one
-- shape and deduplicate on eventId. Additive and nullable: rows written before
-- this migration, and the previous image, leave it NULL.
SET LOCAL lock_timeout = '5s';

ALTER TABLE notification_outbox
    ADD COLUMN envelope JSONB;

ALTER TABLE notification_outbox
    ADD CONSTRAINT notification_outbox_envelope_shape CHECK (
        envelope IS NULL
        OR (
            jsonb_typeof(envelope) = 'object'
            AND envelope ? 'eventId'
            AND envelope ? 'type'
            AND envelope ? 'schemaVersion'
            AND envelope ? 'payload'
        )
    );

-- Once written, an envelope is evidence of what was published: it never changes.
CREATE FUNCTION protect_notification_outbox_envelope() RETURNS trigger AS $$
BEGIN
    IF OLD.envelope IS NOT NULL AND NEW.envelope IS DISTINCT FROM OLD.envelope THEN
        RAISE EXCEPTION 'notification_outbox envelope is immutable once written'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_outbox_envelope_immutable
    BEFORE UPDATE OF envelope ON notification_outbox
    FOR EACH ROW EXECUTE FUNCTION protect_notification_outbox_envelope();
