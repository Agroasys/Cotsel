module.exports = class Data1784908010586 {
  name = 'Data1784908010586';

  async up(db) {
    await db.query(`ALTER TABLE "trade_event" ADD "pause_triggered_by" text`);
    await db.query(`ALTER TABLE "trade" ADD "paused" boolean NOT NULL`);
    await db.query(`CREATE INDEX "IDX_3f7871870e4763dd365c9e17cb" ON "trade"  ("paused") `);
  }

  async down(db) {
    await db.query(`DROP INDEX "public"."IDX_3f7871870e4763dd365c9e17cb"`);
    await db.query(`ALTER TABLE "trade" DROP COLUMN "paused"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN "pause_triggered_by"`);
  }
};
