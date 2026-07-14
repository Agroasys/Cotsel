module.exports = class InspectionEventFields1784042818000 {
  name = 'InspectionEventFields1784042818000';

  async up(db) {
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "inspection_available_at" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "inspection_window_seconds" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "inspection_notice_deadline" numeric`,
    );
    await db.query(
      `ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "inspection_accepted_at" numeric`,
    );
  }

  async down(db) {
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "inspection_accepted_at"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "inspection_notice_deadline"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "inspection_window_seconds"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "inspection_available_at"`);
  }
};
