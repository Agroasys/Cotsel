module.exports = class Data1774031059140 {
    name = 'Data1774031059140'

    async up(db) {
        await db.query(`DROP INDEX "public"."IDX_trade_event_extrinsic_hash"`)
        await db.query(`DROP INDEX "public"."IDX_dispute_event_extrinsic_hash"`)
        await db.query(`DROP INDEX "public"."IDX_oracle_event_extrinsic_hash"`)
        await db.query(`DROP INDEX "public"."IDX_admin_event_extrinsic_hash"`)
        await db.query(`DROP INDEX "public"."IDX_system_event_extrinsic_hash"`)
        await db.query(`DROP INDEX "public"."IDX_system_event_proposal_id"`)
        await db.query(`DROP INDEX "public"."IDX_system_event_payout_receiver"`)
        await db.query(`CREATE INDEX "IDX_b298570fc62a260408e4f0425c" ON "trade_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_33f3c5c3b973e7b25e2bac73e5" ON "dispute_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_56a2c8ae067038ee82427693ef" ON "oracle_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_5f5426f9c1ff5fae064b673ed0" ON "admin_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_c81998b1dc03c6b884b6b2bed0" ON "system_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_fb1d8b8f54aaff0d07d724a727" ON "system_event" ("proposal_id") `)
        await db.query(`CREATE INDEX "IDX_43f0b7b7f3d8d404241de69b67" ON "system_event" ("payout_receiver") `)
    }

    async down(db) {
        await db.query(`CREATE INDEX "IDX_trade_event_extrinsic_hash" ON "trade_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_dispute_event_extrinsic_hash" ON "dispute_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_oracle_event_extrinsic_hash" ON "oracle_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_admin_event_extrinsic_hash" ON "admin_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_system_event_extrinsic_hash" ON "system_event" ("extrinsic_hash") `)
        await db.query(`CREATE INDEX "IDX_system_event_proposal_id" ON "system_event" ("proposal_id") `)
        await db.query(`CREATE INDEX "IDX_system_event_payout_receiver" ON "system_event" ("payout_receiver") `)
        await db.query(`DROP INDEX "public"."IDX_b298570fc62a260408e4f0425c"`)
        await db.query(`DROP INDEX "public"."IDX_33f3c5c3b973e7b25e2bac73e5"`)
        await db.query(`DROP INDEX "public"."IDX_56a2c8ae067038ee82427693ef"`)
        await db.query(`DROP INDEX "public"."IDX_5f5426f9c1ff5fae064b673ed0"`)
        await db.query(`DROP INDEX "public"."IDX_c81998b1dc03c6b884b6b2bed0"`)
        await db.query(`DROP INDEX "public"."IDX_fb1d8b8f54aaff0d07d724a727"`)
        await db.query(`DROP INDEX "public"."IDX_43f0b7b7f3d8d404241de69b67"`)
    }
}