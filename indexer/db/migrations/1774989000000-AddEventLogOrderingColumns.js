module.exports = class AddEventLogOrderingColumns1774989000000 {
  name = 'AddEventLogOrderingColumns1774989000000';

  async up(db) {
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "log_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "transaction_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_trade_event_log_index" ON "trade_event" ("log_index")`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_trade_event_transaction_index" ON "trade_event" ("transaction_index")`,
    );

    await db.query(
      `ALTER TABLE "dispute_event" ADD COLUMN IF NOT EXISTS "log_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `ALTER TABLE "dispute_event" ADD COLUMN IF NOT EXISTS "transaction_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dispute_event_log_index" ON "dispute_event" ("log_index")`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dispute_event_transaction_index" ON "dispute_event" ("transaction_index")`,
    );

    await db.query(
      `ALTER TABLE "oracle_event" ADD COLUMN IF NOT EXISTS "log_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `ALTER TABLE "oracle_event" ADD COLUMN IF NOT EXISTS "transaction_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_oracle_event_log_index" ON "oracle_event" ("log_index")`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_oracle_event_transaction_index" ON "oracle_event" ("transaction_index")`,
    );

    await db.query(
      `ALTER TABLE "admin_event" ADD COLUMN IF NOT EXISTS "log_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `ALTER TABLE "admin_event" ADD COLUMN IF NOT EXISTS "transaction_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_admin_event_log_index" ON "admin_event" ("log_index")`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_admin_event_transaction_index" ON "admin_event" ("transaction_index")`,
    );

    await db.query(
      `ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "log_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "transaction_index" integer NOT NULL DEFAULT 0`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_system_event_log_index" ON "system_event" ("log_index")`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS "IDX_system_event_transaction_index" ON "system_event" ("transaction_index")`,
    );
  }

  async down(db) {
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_system_event_transaction_index"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_system_event_log_index"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "transaction_index"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "log_index"`);

    await db.query(`DROP INDEX IF EXISTS "public"."IDX_admin_event_transaction_index"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_admin_event_log_index"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN IF EXISTS "transaction_index"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN IF EXISTS "log_index"`);

    await db.query(`DROP INDEX IF EXISTS "public"."IDX_oracle_event_transaction_index"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_oracle_event_log_index"`);
    await db.query(`ALTER TABLE "oracle_event" DROP COLUMN IF EXISTS "transaction_index"`);
    await db.query(`ALTER TABLE "oracle_event" DROP COLUMN IF EXISTS "log_index"`);

    await db.query(`DROP INDEX IF EXISTS "public"."IDX_dispute_event_transaction_index"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_dispute_event_log_index"`);
    await db.query(`ALTER TABLE "dispute_event" DROP COLUMN IF EXISTS "transaction_index"`);
    await db.query(`ALTER TABLE "dispute_event" DROP COLUMN IF EXISTS "log_index"`);

    await db.query(`DROP INDEX IF EXISTS "public"."IDX_trade_event_transaction_index"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_trade_event_log_index"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "transaction_index"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "log_index"`);
  }
};
