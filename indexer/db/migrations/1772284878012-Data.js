module.exports = class Data1772284878012 {
    name = 'Data1772284878012'

    async up(db) {
        await db.query(`ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "claim_type" character varying(31)`)
        await db.query(`ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "claim_recipient" text`)
        await db.query(`ALTER TABLE "trade_event" ADD COLUMN IF NOT EXISTS "claim_amount" numeric`)
        await db.query(`ALTER TABLE "oracle_event" ADD COLUMN IF NOT EXISTS "disabled_by" text`)
        await db.query(`ALTER TABLE "oracle_event" ADD COLUMN IF NOT EXISTS "previous_oracle" text`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "claim_amount" numeric`)
    }

    async down(db) {
        await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "claim_type"`)
        await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "claim_recipient"`)
        await db.query(`ALTER TABLE "trade_event" DROP COLUMN IF EXISTS "claim_amount"`)
        await db.query(`ALTER TABLE "oracle_event" DROP COLUMN IF EXISTS "disabled_by"`)
        await db.query(`ALTER TABLE "oracle_event" DROP COLUMN IF EXISTS "previous_oracle"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "claim_amount"`)
    }
}
