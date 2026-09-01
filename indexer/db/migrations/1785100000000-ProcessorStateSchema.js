module.exports = class ProcessorStateSchema1785100000000 {
  name = 'ProcessorStateSchema1785100000000';

  async up(db) {
    await db.query(`CREATE SCHEMA IF NOT EXISTS "squid_processor"`);
    await db.query(
      `CREATE TABLE IF NOT EXISTS "squid_processor"."status" ("id" int4 PRIMARY KEY, "height" int4 NOT NULL, "hash" text DEFAULT '0x', "nonce" int4 DEFAULT 0)`,
    );
    await db.query(
      `ALTER TABLE "squid_processor"."status" ADD COLUMN IF NOT EXISTS "hash" text DEFAULT '0x'`,
    );
    await db.query(
      `ALTER TABLE "squid_processor"."status" ADD COLUMN IF NOT EXISTS "nonce" int4 DEFAULT 0`,
    );
    await db.query(
      `CREATE TABLE IF NOT EXISTS "squid_processor"."hot_block" ("height" int4 PRIMARY KEY, "hash" text NOT NULL)`,
    );
    await db.query(
      `CREATE TABLE IF NOT EXISTS "squid_processor"."hot_change_log" ("block_height" int4 NOT NULL REFERENCES "squid_processor"."hot_block" ON DELETE CASCADE, "index" int4 NOT NULL, "change" jsonb NOT NULL, PRIMARY KEY ("block_height", "index"))`,
    );
    await db.query(
      `CREATE TABLE IF NOT EXISTS "squid_processor"."template_registry" ("key" text NOT NULL, "value" text NOT NULL, "type" boolean NOT NULL, "block_number" int4 NOT NULL, "height" int4 NOT NULL, PRIMARY KEY ("key", "value", "type", "block_number", "height"))`,
    );
    await db.query(`
      DO $migration$
      DECLARE
        primary_key_name text;
        primary_key_has_height boolean;
      BEGIN
        SELECT constraint_row.conname,
               EXISTS (
                 SELECT 1
                 FROM unnest(constraint_row.conkey) AS key_column(attnum)
                 JOIN pg_attribute attribute_row
                   ON attribute_row.attrelid = constraint_row.conrelid
                  AND attribute_row.attnum = key_column.attnum
                 WHERE attribute_row.attname = 'height'
               )
          INTO primary_key_name, primary_key_has_height
          FROM pg_constraint constraint_row
         WHERE constraint_row.contype = 'p'
           AND constraint_row.conrelid = '"squid_processor"."template_registry"'::regclass;

        IF primary_key_name IS NULL THEN
          ALTER TABLE "squid_processor"."template_registry"
            ADD PRIMARY KEY ("key", "value", "type", "block_number", "height");
        ELSIF NOT primary_key_has_height THEN
          EXECUTE format(
            'ALTER TABLE "squid_processor"."template_registry" DROP CONSTRAINT %I',
            primary_key_name
          );
          ALTER TABLE "squid_processor"."template_registry"
            ADD PRIMARY KEY ("key", "value", "type", "block_number", "height");
        END IF;
      END
      $migration$;
    `);
  }

  async down() {
    throw new Error(
      'Processor state schema rollback is destructive; preserve checkpoint state and use a reviewed forward fix',
    );
  }
};
