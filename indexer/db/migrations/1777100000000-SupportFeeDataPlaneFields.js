module.exports = class SupportFeeDataPlaneFields1777100000000 {
  name = 'SupportFeeDataPlaneFields1777100000000';

  async up(db) {
    await db.query(
      `ALTER TABLE "trade" ADD COLUMN IF NOT EXISTS "platform_fee_net_amount" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade" ADD COLUMN IF NOT EXISTS "settlement_support_fee_amount" numeric`,
    );
    await db.query(
      `UPDATE "trade"
       SET
         "settlement_support_fee_amount" = LEAST("platform_fees_amount", 4000000),
         "platform_fee_net_amount" = "platform_fees_amount" - LEAST("platform_fees_amount", 4000000)
       WHERE "platform_fee_net_amount" IS NULL
          OR "settlement_support_fee_amount" IS NULL`,
    );
    await db.query(`ALTER TABLE "trade" ALTER COLUMN "platform_fee_net_amount" SET NOT NULL`);
    await db.query(`ALTER TABLE "trade" ALTER COLUMN "settlement_support_fee_amount" SET NOT NULL`);

    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "platform_fee_net_amount" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "settlement_support_fee_amount" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "paid_platform_fee_net" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "paid_settlement_support_fee" numeric`,
    );
  }

  async down(db) {
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "paid_settlement_support_fee"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "paid_platform_fee_net"`);
    await db.query(
      `ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "settlement_support_fee_amount"`,
    );
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "platform_fee_net_amount"`);
    await db.query(`ALTER TABLE "trade" DROP COLUMN IF EXISTS "settlement_support_fee_amount"`);
    await db.query(`ALTER TABLE "trade" DROP COLUMN IF EXISTS "platform_fee_net_amount"`);
  }
};
