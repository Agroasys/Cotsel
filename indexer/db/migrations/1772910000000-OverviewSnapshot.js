module.exports = class OverviewSnapshot1772910000000 {
    name = 'OverviewSnapshot1772910000000'

    async up(db) {
        await db.query(`CREATE TABLE "overview_snapshot" ("id" character varying NOT NULL, "total_trades" integer NOT NULL, "locked_trades" integer NOT NULL, "stage1_trades" integer NOT NULL, "stage2_trades" integer NOT NULL, "completed_trades" integer NOT NULL, "disputed_trades" integer NOT NULL, "cancelled_trades" integer NOT NULL, "last_processed_block" numeric NOT NULL, "last_indexed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_trade_event_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_f1d54f00bd78fa1889671dfb8f0" PRIMARY KEY ("id"))`)
    }

    async down(db) {
        await db.query(`DROP TABLE "overview_snapshot"`)
    }
}