module.exports = class DropLegacyEventIdentityFields1776000000000 {
  name = 'DropLegacyEventIdentityFields1776000000000';

  async up(db) {
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_trade_event_extrinsic_hash"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_dispute_event_extrinsic_hash"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_oracle_event_extrinsic_hash"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_admin_event_extrinsic_hash"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_system_event_extrinsic_hash"`);

    await db.query(`DROP INDEX IF EXISTS "public"."IDX_b298570fc62a260408e4f0425c"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_33f3c5c3b973e7b25e2bac73e5"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_56a2c8ae067038ee82427693ef"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_5f5426f9c1ff5fae064b673ed0"`);
    await db.query(`DROP INDEX IF EXISTS "public"."IDX_c81998b1dc03c6b884b6b2bed0"`);

    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "extrinsic_hash"`);
    await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "extrinsic_index"`);
    await db.query(`ALTER TABLE "dispute_event" DROP COLUMN IF EXISTS "extrinsic_hash"`);
    await db.query(`ALTER TABLE "dispute_event" DROP COLUMN IF EXISTS "extrinsic_index"`);
    await db.query(`ALTER TABLE "oracle_event" DROP COLUMN IF EXISTS "extrinsic_hash"`);
    await db.query(`ALTER TABLE "oracle_event" DROP COLUMN IF EXISTS "extrinsic_index"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN IF EXISTS "extrinsic_hash"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN IF EXISTS "extrinsic_index"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "extrinsic_hash"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "extrinsic_index"`);
  }

  async down() {
    throw new Error('This migration is irreversible.');
  }
};
