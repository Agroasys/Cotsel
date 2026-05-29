module.exports = class BuyerRefundEventFields1777200000000 {
  name = 'BuyerRefundEventFields1777200000000';

  async up(db) {
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "buyer_refund_recipient" text`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "buyer_refund_amount" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "buyer_refund_type" character varying(31)`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "buyer_refund_triggered_by" text`,
    );
  }

  async down(db) {
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "buyer_refund_triggered_by"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "buyer_refund_type"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "buyer_refund_amount"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "buyer_refund_recipient"`);
  }
};
