module.exports = class ProtocolGovernance1785000000000 {
  name = 'ProtocolGovernance1785000000000';

  async up(db) {
    await db.query(`ALTER TABLE "admin_add_proposal" RENAME TO "admin_change_proposal"`);
    await db.query(
      `ALTER TABLE "admin_event" RENAME COLUMN "admin_add_proposal_id" TO "admin_change_proposal_id"`,
    );
    await db.query(`ALTER TABLE "admin_change_proposal" ALTER COLUMN "new_admin" DROP NOT NULL`);
    await db.query(`ALTER TABLE "admin_change_proposal" ADD "kind" integer NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE "admin_change_proposal" ADD "current_admin" text`);
    await db.query(
      `ALTER TABLE "admin_change_proposal" ADD "new_threshold" numeric NOT NULL DEFAULT 0`,
    );
    await db.query(`ALTER TABLE "admin_change_proposal" ADD "epoch" numeric NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE "admin_event" RENAME COLUMN "proposed_admin" TO "new_admin"`);
    await db.query(`ALTER TABLE "admin_event" ADD "admin_change_kind" integer`);
    await db.query(`ALTER TABLE "admin_event" ADD "current_admin" text`);
    await db.query(`ALTER TABLE "admin_event" ADD "new_threshold" numeric`);
    await db.query(`ALTER TABLE "admin_event" ADD "governance_epoch" numeric`);
    await db.query(`ALTER TABLE "admin_event" ADD "removed_admin" text`);
    await db.query(`ALTER TABLE "admin_event" ADD "old_admin" text`);
    await db.query(`ALTER TABLE "admin_event" ADD "replacement_admin" text`);
    await db.query(`ALTER TABLE "system_event" ADD "pause_scope" integer`);
    await db.query(`ALTER TABLE "system_event" ADD "pause_trade_id" numeric`);
    await db.query(`ALTER TABLE "system_event" ADD "incident_ref" text`);
    await db.query(`ALTER TABLE "system_event" ADD "governance_epoch" numeric`);
    await db.query(`ALTER TABLE "system_event" ADD "old_threshold" numeric`);
    await db.query(`ALTER TABLE "system_event" ADD "new_threshold" numeric`);
    await db.query(
      `CREATE INDEX "idx_admin_change_proposal_kind_c17f9b30" ON "admin_change_proposal" ("kind")`,
    );
  }

  async down(db) {
    await db.query(`DROP INDEX "public"."idx_admin_change_proposal_kind_c17f9b30"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN "new_threshold"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN "old_threshold"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN "governance_epoch"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN "incident_ref"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN "pause_trade_id"`);
    await db.query(`ALTER TABLE "system_event" DROP COLUMN "pause_scope"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN "replacement_admin"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN "old_admin"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN "removed_admin"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN "governance_epoch"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN "new_threshold"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN "current_admin"`);
    await db.query(`ALTER TABLE "admin_event" DROP COLUMN "admin_change_kind"`);
    await db.query(`ALTER TABLE "admin_event" RENAME COLUMN "new_admin" TO "proposed_admin"`);
    await db.query(`ALTER TABLE "admin_change_proposal" DROP COLUMN "epoch"`);
    await db.query(`ALTER TABLE "admin_change_proposal" DROP COLUMN "new_threshold"`);
    await db.query(`ALTER TABLE "admin_change_proposal" DROP COLUMN "current_admin"`);
    await db.query(`ALTER TABLE "admin_change_proposal" DROP COLUMN "kind"`);
    await db.query(
      `UPDATE "admin_change_proposal" SET "new_admin" = '0x0000000000000000000000000000000000000000' WHERE "new_admin" IS NULL`,
    );
    await db.query(`ALTER TABLE "admin_change_proposal" ALTER COLUMN "new_admin" SET NOT NULL`);
    await db.query(
      `ALTER TABLE "admin_event" RENAME COLUMN "admin_change_proposal_id" TO "admin_add_proposal_id"`,
    );
    await db.query(`ALTER TABLE "admin_change_proposal" RENAME TO "admin_add_proposal"`);
  }
};
