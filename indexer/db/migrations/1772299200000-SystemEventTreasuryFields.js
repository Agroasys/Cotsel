module.exports = class SystemEventTreasuryFields1772299200000 {
    name = 'SystemEventTreasuryFields1772299200000'

    async up(db) {
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "proposal_id" text`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "treasury_identity" text`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "payout_receiver" text`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "old_payout_receiver" text`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "new_payout_receiver" text`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "approval_count" integer`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "required_approvals" integer`)
        await db.query(`ALTER TABLE "system_event" ADD COLUMN IF NOT EXISTS "eta" numeric`)

        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_system_event_proposal_id" ON "system_event" ("proposal_id")`)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_system_event_payout_receiver" ON "system_event" ("payout_receiver")`)
    }

    async down(db) {
        await db.query(`DROP INDEX IF EXISTS "IDX_system_event_proposal_id"`)
        await db.query(`DROP INDEX IF EXISTS "IDX_system_event_payout_receiver"`)

        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "eta"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "required_approvals"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "approval_count"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "new_payout_receiver"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "old_payout_receiver"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "payout_receiver"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "treasury_identity"`)
        await db.query(`ALTER TABLE "system_event" DROP COLUMN IF EXISTS "proposal_id"`)
    }
}
