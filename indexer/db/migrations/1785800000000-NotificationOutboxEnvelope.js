/**
 * Store the registered event envelope with every outbox row (Cotsel#949,
 * docs/api/events/envelope.v1.schema.json). Same column contract as the oracle
 * and reconciliation outboxes; `@agroasys/notifications` writes it. Additive and
 * nullable, so rows written before this migration, and the previous image,
 * leave it NULL.
 */
module.exports = class NotificationOutboxEnvelope1785800000000 {
  name = 'NotificationOutboxEnvelope1785800000000';

  async up(db) {
    await db.query(`ALTER TABLE "notification_outbox" ADD COLUMN "envelope" JSONB`);
    await db.query(`ALTER TABLE "notification_outbox"
      ADD CONSTRAINT "notification_outbox_envelope_shape" CHECK (
        "envelope" IS NULL
        OR (
          jsonb_typeof("envelope") = 'object'
          AND "envelope" ? 'eventId'
          AND "envelope" ? 'type'
          AND "envelope" ? 'schemaVersion'
          AND "envelope" ? 'payload'
        )
      )`);
    // Once written, an envelope is evidence of what was published: it never changes.
    await db.query(`CREATE FUNCTION protect_notification_outbox_envelope() RETURNS trigger AS $$
      BEGIN
        IF OLD.envelope IS NOT NULL AND NEW.envelope IS DISTINCT FROM OLD.envelope THEN
          RAISE EXCEPTION 'notification_outbox envelope is immutable once written'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await db.query(`CREATE TRIGGER notification_outbox_envelope_immutable
      BEFORE UPDATE OF envelope ON "notification_outbox"
      FOR EACH ROW EXECUTE FUNCTION protect_notification_outbox_envelope()`);
  }

  async down(db) {
    await db.query(`DROP TRIGGER notification_outbox_envelope_immutable ON "notification_outbox"`);
    await db.query(`DROP FUNCTION protect_notification_outbox_envelope()`);
    // The envelope duplicates the event column, so dropping it loses no evidence.
    await db.query(
      `ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_envelope_shape"`,
    );
    await db.query(`ALTER TABLE "notification_outbox" DROP COLUMN "envelope"`);
  }
};
