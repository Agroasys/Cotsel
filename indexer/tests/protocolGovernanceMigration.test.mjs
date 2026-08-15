import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import ProtocolGovernanceMigration from '../db/migrations/1785000000000-ProtocolGovernance.js';

const databaseUrl = process.env.INDEXER_MIGRATION_TEST_DATABASE_URL?.trim();

async function resetSchema(client) {
  await client.query('DROP TABLE IF EXISTS "admin_event" CASCADE');
  await client.query('DROP TABLE IF EXISTS "admin_change_proposal" CASCADE');
  await client.query('DROP TABLE IF EXISTS "admin_add_proposal" CASCADE');
  await client.query('DROP TABLE IF EXISTS "system_event" CASCADE');
}

async function createLegacySchema(client) {
  await client.query(`
    CREATE TABLE "admin_add_proposal" (
      "id" text PRIMARY KEY,
      "proposal_id" text NOT NULL,
      "new_admin" text NOT NULL,
      "approval_count" integer NOT NULL,
      "executed" boolean NOT NULL,
      "created_at" timestamptz NOT NULL,
      "eta" numeric NOT NULL,
      "proposer" text NOT NULL,
      "expires_at" timestamptz,
      "cancelled" boolean NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE "admin_event" (
      "id" text PRIMARY KEY,
      "admin_add_proposal_id" text REFERENCES "admin_add_proposal"("id"),
      "proposed_admin" text
    )
  `);
  await client.query(`CREATE TABLE "system_event" ("id" text PRIMARY KEY)`);
  await client.query(`
    INSERT INTO "admin_add_proposal" (
      "id", "proposal_id", "new_admin", "approval_count", "executed", "created_at",
      "eta", "proposer", "expires_at", "cancelled"
    ) VALUES (
      '7', '7', '0x1111111111111111111111111111111111111111', 2, false,
      '2026-08-15T00:00:00Z', 1800000000, '0x2222222222222222222222222222222222222222',
      NULL, false
    )
  `);
  await client.query(`
    INSERT INTO "admin_event" ("id", "admin_add_proposal_id", "proposed_admin")
    VALUES ('event-7', '7', '0x1111111111111111111111111111111111111111')
  `);
}

test(
  'ProtocolGovernance migration preserves legacy proposals and relationships',
  { skip: !databaseUrl },
  async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await resetSchema(client);
      await createLegacySchema(client);
      const migration = new ProtocolGovernanceMigration();
      await migration.up(client);

      const proposal = await client.query(
        'SELECT "id", "kind", "new_admin", "new_threshold", "epoch" FROM "admin_change_proposal"',
      );
      assert.deepEqual(proposal.rows, [
        {
          id: '7',
          kind: 0,
          new_admin: '0x1111111111111111111111111111111111111111',
          new_threshold: '0',
          epoch: '0',
        },
      ]);
      const relation = await client.query(
        'SELECT "admin_change_proposal_id", "new_admin" FROM "admin_event"',
      );
      assert.deepEqual(relation.rows, [
        {
          admin_change_proposal_id: '7',
          new_admin: '0x1111111111111111111111111111111111111111',
        },
      ]);

      await migration.down(client);
      const restored = await client.query(
        'SELECT "admin_add_proposal_id", "proposed_admin" FROM "admin_event"',
      );
      assert.equal(restored.rows[0].admin_add_proposal_id, '7');
      assert.equal(restored.rows[0].proposed_admin, '0x1111111111111111111111111111111111111111');
    } finally {
      await resetSchema(client);
      await client.end();
    }
  },
);

test('ProtocolGovernance migration refuses a lossy rollback', { skip: !databaseUrl }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await resetSchema(client);
    await createLegacySchema(client);
    const migration = new ProtocolGovernanceMigration();
    await migration.up(client);
    await client.query(`
        UPDATE "admin_change_proposal"
        SET "kind" = 3, "new_admin" = NULL, "new_threshold" = 3, "epoch" = 2
        WHERE "id" = '7'
      `);
    await assert.rejects(() => migration.down(client), /rollback is unsafe/);
  } finally {
    await resetSchema(client);
    await client.end();
  }
});
