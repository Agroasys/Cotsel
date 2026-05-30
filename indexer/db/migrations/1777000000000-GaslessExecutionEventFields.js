module.exports = class GaslessExecutionEventFields1777000000000 {
  name = 'GaslessExecutionEventFields1777000000000';

  async up(db) {
    await db.query(`ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "relayed_action" text`);
    await db.query(`ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "relayed_user" text`);
    await db.query(`ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "relayed_relayer" text`);
    await db.query(`ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "gasless_buyer" text`);
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "usdc_authorization_nonce" text`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "supplier_payout_recipient" text`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "supplier_payout_amount" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "supplier_payout_type" character varying(31)`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "supplier_payout_triggered_by" text`,
    );
    await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "authorization_user" text`);
    await db.query(
      `ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "authorization_action" text`,
    );
    await db.query(
      `ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "authorization_nonce" numeric`,
    );
    await db.query(
      `ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "authorization_relayer" text`,
    );
    await db.query(
      `ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "authorization_deadline" numeric`,
    );
  }

  async down(db) {
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "authorization_deadline"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "authorization_relayer"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "authorization_nonce"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "authorization_action"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "authorization_user"`);

    await db.query(
      `ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "supplier_payout_triggered_by"`,
    );
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "supplier_payout_type"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "supplier_payout_amount"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "supplier_payout_recipient"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "usdc_authorization_nonce"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "gasless_buyer"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "relayed_relayer"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "relayed_user"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "relayed_action"`);
  }
};
