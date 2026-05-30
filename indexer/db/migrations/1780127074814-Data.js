module.exports = class Data1780127074814 {
  name = 'Data1780127074814';

  async up(db) {
    await db.query(`DROP INDEX "public"."IDX_trade_event_log_index"`);
    await db.query(`DROP INDEX "public"."IDX_trade_event_transaction_index"`);
    await db.query(`DROP INDEX "public"."IDX_dispute_event_log_index"`);
    await db.query(`DROP INDEX "public"."IDX_dispute_event_transaction_index"`);
    await db.query(`DROP INDEX "public"."IDX_oracle_event_log_index"`);
    await db.query(`DROP INDEX "public"."IDX_oracle_event_transaction_index"`);
    await db.query(`DROP INDEX "public"."IDX_admin_event_log_index"`);
    await db.query(`DROP INDEX "public"."IDX_admin_event_transaction_index"`);
    await db.query(`DROP INDEX "public"."IDX_system_event_log_index"`);
    await db.query(`DROP INDEX "public"."IDX_system_event_transaction_index"`);
    await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "tx_hash" SET NOT NULL`);
    await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "log_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "transaction_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "tx_hash" SET NOT NULL`);
    await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "log_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "transaction_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "tx_hash" SET NOT NULL`);
    await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "log_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "transaction_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "tx_hash" SET NOT NULL`);
    await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "log_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "transaction_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "system_event" ALTER COLUMN "tx_hash" SET NOT NULL`);
    await db.query(`ALTER TABLE "system_event" ALTER COLUMN "log_index" DROP DEFAULT`);
    await db.query(`ALTER TABLE "system_event" ALTER COLUMN "transaction_index" DROP DEFAULT`);
    await db.query(`CREATE INDEX "IDX_35f6b75b862075574f9717e932" ON "trade_event" ("log_index") `);
    await db.query(
      `CREATE INDEX "IDX_fa1da05ab74bf9059fb5c62d8e" ON "trade_event" ("transaction_index") `,
    );
    await db.query(
      `CREATE INDEX "IDX_3158ee87b826d9938dc8286659" ON "dispute_event" ("log_index") `,
    );
    await db.query(
      `CREATE INDEX "IDX_d8ac170d5890b1eab54b47bac1" ON "dispute_event" ("transaction_index") `,
    );
    await db.query(
      `CREATE INDEX "IDX_e683fd8f2d081d4a881d4531c6" ON "oracle_event" ("log_index") `,
    );
    await db.query(
      `CREATE INDEX "IDX_5386b64673890d248c5cfb5444" ON "oracle_event" ("transaction_index") `,
    );
    await db.query(`CREATE INDEX "IDX_c8700c9378d8adb23441145c73" ON "admin_event" ("log_index") `);
    await db.query(
      `CREATE INDEX "IDX_659046f8eaf29c332feb74e9da" ON "admin_event" ("transaction_index") `,
    );
    await db.query(
      `CREATE INDEX "IDX_99bb8e7bc80926a00c2d938cfa" ON "system_event" ("log_index") `,
    );
    await db.query(
      `CREATE INDEX "IDX_0fe321e0735f87264082f498fc" ON "system_event" ("transaction_index") `,
    );
  }

  async down(db) {
    await db.query(`DROP INDEX "public"."IDX_0fe321e0735f87264082f498fc"`);
    await db.query(`DROP INDEX "public"."IDX_99bb8e7bc80926a00c2d938cfa"`);
    await db.query(`DROP INDEX "public"."IDX_659046f8eaf29c332feb74e9da"`);
    await db.query(`DROP INDEX "public"."IDX_c8700c9378d8adb23441145c73"`);
    await db.query(`DROP INDEX "public"."IDX_5386b64673890d248c5cfb5444"`);
    await db.query(`DROP INDEX "public"."IDX_e683fd8f2d081d4a881d4531c6"`);
    await db.query(`DROP INDEX "public"."IDX_d8ac170d5890b1eab54b47bac1"`);
    await db.query(`DROP INDEX "public"."IDX_3158ee87b826d9938dc8286659"`);
    await db.query(`DROP INDEX "public"."IDX_fa1da05ab74bf9059fb5c62d8e"`);
    await db.query(`DROP INDEX "public"."IDX_35f6b75b862075574f9717e932"`);
    await db.query(`ALTER TABLE "system_event" ALTER COLUMN "transaction_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "system_event" ALTER COLUMN "log_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "system_event" ALTER COLUMN "tx_hash" DROP NOT NULL`);
    await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "transaction_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "log_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "tx_hash" DROP NOT NULL`);
    await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "transaction_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "log_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "tx_hash" DROP NOT NULL`);
    await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "transaction_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "log_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "tx_hash" DROP NOT NULL`);
    await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "transaction_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "log_index" SET DEFAULT '0'`);
    await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "tx_hash" DROP NOT NULL`);
    await db.query(
      `CREATE INDEX "IDX_system_event_transaction_index" ON "system_event" ("transaction_index") `,
    );
    await db.query(`CREATE INDEX "IDX_system_event_log_index" ON "system_event" ("log_index") `);
    await db.query(
      `CREATE INDEX "IDX_admin_event_transaction_index" ON "admin_event" ("transaction_index") `,
    );
    await db.query(`CREATE INDEX "IDX_admin_event_log_index" ON "admin_event" ("log_index") `);
    await db.query(
      `CREATE INDEX "IDX_oracle_event_transaction_index" ON "oracle_event" ("transaction_index") `,
    );
    await db.query(`CREATE INDEX "IDX_oracle_event_log_index" ON "oracle_event" ("log_index") `);
    await db.query(
      `CREATE INDEX "IDX_dispute_event_transaction_index" ON "dispute_event" ("transaction_index") `,
    );
    await db.query(`CREATE INDEX "IDX_dispute_event_log_index" ON "dispute_event" ("log_index") `);
    await db.query(
      `CREATE INDEX "IDX_trade_event_transaction_index" ON "trade_event" ("transaction_index") `,
    );
    await db.query(`CREATE INDEX "IDX_trade_event_log_index" ON "trade_event" ("log_index") `);
  }
};
