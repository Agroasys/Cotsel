module.exports = class EventHashSeparation1771815600000 {
    name = 'EventHashSeparation1771815600000'

    async up(db) {
        await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "tx_hash" DROP NOT NULL`)
        await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "tx_hash" DROP NOT NULL`)
        await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "tx_hash" DROP NOT NULL`)
        await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "tx_hash" DROP NOT NULL`)
        await db.query(`ALTER TABLE "system_event" ALTER COLUMN "tx_hash" DROP NOT NULL`)

        await db.query(`ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "extrinsic_hash" text`)
        await db.query(`ALTER TABLE "dispute_event" ADD COLUMN IF NOT EXISTS "extrinsic_hash" text`)
        await db.query(`ALTER TABLE "oracle_event" ADD COLUMN IF NOT EXISTS "extrinsic_hash" text`)
        await db.query(`ALTER TABLE "admin_event" ADD COLUMN IF NOT EXISTS "extrinsic_hash" text`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "extrinsic_hash" text`)

        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_trade_event_extrinsic_hash" ON "trade_event" ("extrinsic_hash")`)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_dispute_event_extrinsic_hash" ON "dispute_event" ("extrinsic_hash")`)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_oracle_event_extrinsic_hash" ON "oracle_event" ("extrinsic_hash")`)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_admin_event_extrinsic_hash" ON "admin_event" ("extrinsic_hash")`)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_system_event_extrinsic_hash" ON "system_event" ("extrinsic_hash")`)
    }

    async down(db) {
        await db.query(`DROP INDEX IF EXISTS "IDX_trade_event_extrinsic_hash"`)
        await db.query(`DROP INDEX IF EXISTS "IDX_dispute_event_extrinsic_hash"`)
        await db.query(`DROP INDEX IF EXISTS "IDX_oracle_event_extrinsic_hash"`)
        await db.query(`DROP INDEX IF EXISTS "IDX_admin_event_extrinsic_hash"`)
        await db.query(`DROP INDEX IF EXISTS "IDX_system_event_extrinsic_hash"`)

        await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "extrinsic_hash"`)
        await db.query(`ALTER TABLE "dispute_event" DROP COLUMN IF EXISTS "extrinsic_hash"`)
        await db.query(`ALTER TABLE "oracle_event" DROP COLUMN IF EXISTS "extrinsic_hash"`)
        await db.query(`ALTER TABLE "admin_event" DROP COLUMN IF EXISTS "extrinsic_hash"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "extrinsic_hash"`)

        await db.query(`UPDATE "trade_event" SET "tx_hash" = 'unknown' WHERE "tx_hash" IS NULL`)
        await db.query(`UPDATE "dispute_event" SET "tx_hash" = 'unknown' WHERE "tx_hash" IS NULL`)
        await db.query(`UPDATE "oracle_event" SET "tx_hash" = 'unknown' WHERE "tx_hash" IS NULL`)
        await db.query(`UPDATE "admin_event" SET "tx_hash" = 'unknown' WHERE "tx_hash" IS NULL`)
        await db.query(`UPDATE "system_event" SET "tx_hash" = 'unknown' WHERE "tx_hash" IS NULL`)

        await db.query(`ALTER TABLE "trade_event" ALTER COLUMN "tx_hash" SET NOT NULL`)
        await db.query(`ALTER TABLE "dispute_event" ALTER COLUMN "tx_hash" SET NOT NULL`)
        await db.query(`ALTER TABLE "oracle_event" ALTER COLUMN "tx_hash" SET NOT NULL`)
        await db.query(`ALTER TABLE "admin_event" ALTER COLUMN "tx_hash" SET NOT NULL`)
        await db.query(`ALTER TABLE "system_event" ALTER COLUMN "tx_hash" SET NOT NULL`)
    }
}
