import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runLockedIndexerMigration } = require('../migrate');
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('../../shared-db/postgres-test-support');

const declaredMigration = {
  version: '1771180205323',
  typeormName: 'Data1771180205323',
  checksum: 'a'.repeat(64),
};

test(
  'indexer wrapper persists checksums and rejects unchecksummed existing history',
  { timeout: 120000, skip: !dockerAvailable },
  async () => {
    await withPostgresContainer(async ({ port }) => {
      const migrationPool = await createAdminPool(port);
      const commandPool = await createAdminPool(port);

      try {
        await runLockedIndexerMigration({
          pool: migrationPool,
          command: 'controlled-typeorm-apply',
          args: [],
          commandOptions: {},
          migrations: [declaredMigration],
          execute: async () => {
            await commandPool.query(`
              CREATE TABLE public.migrations (
                id SERIAL PRIMARY KEY,
                timestamp BIGINT NOT NULL,
                name VARCHAR NOT NULL
              )
            `);
            await commandPool.query(
              `INSERT INTO public.migrations (timestamp, name) VALUES ($1, $2)`,
              [Number(declaredMigration.version), declaredMigration.typeormName],
            );
          },
        });

        const persisted = await migrationPool.query(
          `SELECT timestamp::text, name, checksum FROM public.migrations`,
        );
        assert.deepEqual(persisted.rows, [
          {
            timestamp: declaredMigration.version,
            name: declaredMigration.typeormName,
            checksum: declaredMigration.checksum,
          },
        ]);

        await migrationPool.query('DROP TABLE public.migrations');
        await migrationPool.query(`
          CREATE TABLE public.migrations (
            id SERIAL PRIMARY KEY,
            timestamp BIGINT NOT NULL,
            name VARCHAR NOT NULL
          )
        `);
        await migrationPool.query(
          `INSERT INTO public.migrations (timestamp, name) VALUES ($1, $2)`,
          [Number(declaredMigration.version), declaredMigration.typeormName],
        );

        await assert.rejects(
          runLockedIndexerMigration({
            pool: migrationPool,
            command: 'must-not-run',
            args: [],
            commandOptions: {},
            migrations: [declaredMigration],
            execute: async () => {
              throw new Error('unchecksummed history was executed');
            },
          }),
          /no durable checksum; stop and create a reviewed adoption design/,
        );
      } finally {
        await migrationPool.end();
        await commandPool.end();
      }
    });
  },
);
