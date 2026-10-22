/**
 * Durable critical notifications (SOW H-26). The poison-log alert is the
 * indexer's critical page, and the pipeline halts right after raising it, so it
 * has to be committed before delivery is attempted. Same column contract as
 * the oracle and reconciliation outboxes; `@agroasys/notifications` owns the
 * queries.
 */
module.exports = class NotificationOutbox1785700000000 {
  name = 'NotificationOutbox1785700000000';

  async up(db) {
    await db.query(`CREATE TABLE notification_outbox (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      event JSONB NOT NULL,
      state TEXT NOT NULL DEFAULT 'PENDING',
      occurrences INTEGER NOT NULL DEFAULT 1,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      dead_lettered_at TIMESTAMPTZ,
      escalation_attempts INTEGER NOT NULL DEFAULT 0,
      escalation_next_attempt_at TIMESTAMPTZ,
      escalation_last_error TEXT,
      escalation_reason TEXT,
      escalated_at TIMESTAMPTZ,
      redriven_from BIGINT REFERENCES notification_outbox(id),
      CONSTRAINT notification_outbox_severity CHECK (severity IN ('info', 'warning', 'critical')),
      CONSTRAINT notification_outbox_state CHECK (state IN ('PENDING', 'DELIVERED', 'DEAD_LETTER')),
      CONSTRAINT notification_outbox_delivered_shape CHECK ((state = 'DELIVERED') = (delivered_at IS NOT NULL)),
      CONSTRAINT notification_outbox_dead_letter_shape CHECK ((state = 'DEAD_LETTER') = (dead_lettered_at IS NOT NULL)),
      CONSTRAINT notification_outbox_escalation_reason CHECK (
          escalation_reason IS NULL OR escalation_reason IN ('DEAD_LETTER', 'DELIVERY_OVERDUE')
      ),
      CONSTRAINT notification_outbox_escalated_shape CHECK ((escalated_at IS NULL) = (escalation_reason IS NULL)),
      CONSTRAINT notification_outbox_counts CHECK (occurrences >= 1 AND attempts >= 0 AND escalation_attempts >= 0)
      )`);
    await db.query(`CREATE UNIQUE INDEX notification_outbox_one_pending_per_dedup_key
      ON notification_outbox(dedup_key) WHERE state = 'PENDING'`);
    await db.query(`CREATE INDEX notification_outbox_due
      ON notification_outbox(next_attempt_at) WHERE state = 'PENDING'`);
    await db.query(`CREATE INDEX notification_outbox_recent_delivery
      ON notification_outbox(dedup_key, delivered_at) WHERE state = 'DELIVERED'`);
    await db.query(`CREATE INDEX notification_outbox_awaiting_escalation
      ON notification_outbox(created_at)
      WHERE severity = 'critical' AND escalated_at IS NULL AND state <> 'DELIVERED'`);
    await db.query(`CREATE FUNCTION protect_notification_outbox_evidence() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $$
      BEGIN
      IF OLD.state <> 'PENDING' AND (
          NEW.state IS DISTINCT FROM OLD.state
          OR NEW.event IS DISTINCT FROM OLD.event
          OR NEW.attempts IS DISTINCT FROM OLD.attempts
          OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
          OR NEW.dead_lettered_at IS DISTINCT FROM OLD.dead_lettered_at
      ) THEN
          RAISE EXCEPTION 'notification_outbox_settled_row_is_immutable';
      END IF;
      IF OLD.escalated_at IS NOT NULL AND (
          NEW.escalated_at IS DISTINCT FROM OLD.escalated_at
          OR NEW.escalation_reason IS DISTINCT FROM OLD.escalation_reason
      ) THEN
          RAISE EXCEPTION 'notification_outbox_escalation_is_immutable';
      END IF;
      RETURN NEW;
      END;
      $$`);
    await db.query(`CREATE TRIGGER notification_outbox_evidence_guard BEFORE UPDATE ON notification_outbox
      FOR EACH ROW EXECUTE FUNCTION protect_notification_outbox_evidence()`);
    // Rows are never deleted: a pending row is a page still owed and a settled
    // one is evidence. The indexer bootstrap grants DELETE on every new table
    // through the migrator's default privileges, so revoke it here, and guard
    // with triggers so a later re-grant cannot reopen deletion.
    await db.query(`CREATE FUNCTION reject_notification_outbox_delete() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $$
      BEGIN
        RAISE EXCEPTION 'notification_outbox_rows_are_retained';
      END;
      $$`);
    await db.query(`CREATE TRIGGER notification_outbox_no_delete BEFORE DELETE ON notification_outbox
      FOR EACH ROW EXECUTE FUNCTION reject_notification_outbox_delete()`);
    await db.query(`CREATE TRIGGER notification_outbox_no_truncate BEFORE TRUNCATE ON notification_outbox
      FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_outbox_delete()`);
    await db.query(`DO $$
      DECLARE
        grantee_name TEXT;
      BEGIN
        REVOKE DELETE, TRUNCATE ON notification_outbox FROM PUBLIC;
        FOR grantee_name IN
          SELECT DISTINCT grantee FROM information_schema.role_table_grants
          WHERE table_schema = 'public'
            AND table_name = 'notification_outbox'
            AND privilege_type IN ('DELETE', 'TRUNCATE')
            AND grantee <> current_user
        LOOP
          EXECUTE format('REVOKE DELETE, TRUNCATE ON notification_outbox FROM %I', grantee_name);
        END LOOP;
      END $$`);
  }

  async down(db) {
    // An undelivered or dead-lettered row is the only record that a page was
    // owed. Dropping the table while any remain would erase that evidence.
    const result = await db.query(`
      SELECT COUNT(*)::integer AS "count"
      FROM "notification_outbox"
      WHERE "state" <> 'DELIVERED'
    `);
    const undelivered = Array.isArray(result)
      ? Number(result[0]?.count ?? 0)
      : Number(result?.rows?.[0]?.count ?? 0);
    if (undelivered > 0) {
      throw new Error(
        `Refusing to drop notification_outbox while ${undelivered} notification(s) are undelivered`,
      );
    }

    await db.query(`DROP TABLE "notification_outbox"`);
    await db.query(`DROP FUNCTION protect_notification_outbox_evidence()`);
    await db.query(`DROP FUNCTION reject_notification_outbox_delete()`);
  }
};
