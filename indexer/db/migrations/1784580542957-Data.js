module.exports = class Data1784580542957 {
  name = 'Data1784580542957';

  async up(db) {
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN "arrival_timestamp"`);
  }

  async down(db) {
    await db.query(`ALTER TABLE "trade_event" ADD "arrival_timestamp" numeric`);
  }
};
