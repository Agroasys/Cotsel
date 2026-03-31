module.exports = class RelaxEventExtrinsicIndexNullability1774990200000 {
    name = 'RelaxEventExtrinsicIndexNullability1774990200000'

    async up(db) {
        await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "extrinsic_index" DROP NOT NULL`)
        await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "extrinsic_index" DROP NOT NULL`)
        await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "extrinsic_index" DROP NOT NULL`)
        await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "extrinsic_index" DROP NOT NULL`)
        await db.query(`ALTER TABLE "system_event" ALTER COLUMN "extrinsic_index" DROP NOT NULL`)
    }

    async down(db) {
        await db.query(`UPDATE "trade_event" SET "extrinsic_index" = 0 WHERE "extrinsic_index" IS NULL`)
        await db.query(`UPDATE "dispute_event" SET "extrinsic_index" = 0 WHERE "extrinsic_index" IS NULL`)
        await db.query(`UPDATE "oracle_event" SET "extrinsic_index" = 0 WHERE "extrinsic_index" IS NULL`)
        await db.query(`UPDATE "admin_event" SET "extrinsic_index" = 0 WHERE "extrinsic_index" IS NULL`)
        await db.query(`UPDATE "system_event" SET "extrinsic_index" = 0 WHERE "extrinsic_index" IS NULL`)
        await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "extrinsic_index" SET NOT NULL`)
        await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "extrinsic_index" SET NOT NULL`)
        await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "extrinsic_index" SET NOT NULL`)
        await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "extrinsic_index" SET NOT NULL`)
        await db.query(`ALTER TABLE "system_event" ALTER COLUMN "extrinsic_index" SET NOT NULL`)
    }
}
