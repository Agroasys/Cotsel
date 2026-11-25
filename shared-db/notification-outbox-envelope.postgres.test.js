'use strict';

// Cotsel#949: the oracle and reconciliation outbox migrations store the event
// envelope, reject a malformed one, and never let a written envelope change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const {
  createAdminPool,
  dockerAvailable,
  withPostgresContainer,
} = require('./postgres-test-support');

// Each service's full migration chain, ending with its envelope migration.
const SERVICES = {
  oracle: 'schema/006_notification_outbox_envelope.sql',
  reconciliation: '008_notification_outbox_envelope.sql',
};

function migrationFilesThrough(root, lastFile) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'migrations.json'), 'utf8'));
  const files = manifest.migrations.map((migration) => migration.file);
  assert.ok(files.includes(lastFile), `${lastFile} is registered in ${root}/migrations.json`);
  return files.slice(0, files.indexOf(lastFile) + 1);
}

const ENVELOPE = {
  eventId: 'evt-1',
  type: 'cotsel.notification',
  schemaVersion: 'v1',
  producer: 'oracle',
  settlementId: '1',
  orderingKey: 'oracle:critical:trade-1',
  occurredAt: '2026-11-23T10:00:00.000Z',
  payload: { type: 'ORACLE_TRIGGER_TERMINAL_FAILURE' },
};

async function insertRow(pool, dedupKey, envelope) {
  const result = await pool.query(
    `INSERT INTO notification_outbox (source, event_type, severity, dedup_key, event, envelope)
     VALUES ('oracle', 'ORACLE_TRIGGER_TERMINAL_FAILURE', 'critical', $1, '{}'::jsonb, $2::jsonb)
     RETURNING id`,
    [dedupKey, envelope === null ? null : JSON.stringify(envelope)],
  );
  return result.rows[0].id;
}

test(
  'oracle and reconciliation outboxes keep a valid, immutable event envelope',
  { timeout: 180000, skip: !dockerAvailable },
  async () => {
    await withPostgresContainer(async ({ port }) => {
      const admin = await createAdminPool(port);
      await admin.query('CREATE ROLE cotsel_outbox_runtime NOLOGIN');
      try {
        for (const [service, envelopeMigration] of Object.entries(SERVICES)) {
          const database = `outbox_envelope_${service}`;
          await admin.query(`CREATE DATABASE ${database}`);
          const pool = new Pool({
            host: '127.0.0.1',
            port,
            database,
            user: 'postgres',
            password: 'postgres',
          });
          try {
            await pool.query(`SET app.runtime_db_user = 'cotsel_outbox_runtime'`);
            await pool.query(`SET app.service_name = '${service}'`);
            const root = path.resolve(__dirname, '..', service, 'src', 'database');
            for (const file of migrationFilesThrough(root, envelopeMigration)) {
              await pool.query(fs.readFileSync(path.join(root, file), 'utf8'));
            }

            const id = await insertRow(pool, `${service}:valid`, ENVELOPE);
            const stored = await pool.query(
              'SELECT envelope FROM notification_outbox WHERE id = $1',
              [id],
            );
            assert.deepEqual(stored.rows[0].envelope, ENVELOPE, `${service}: envelope stored`);

            await assert.rejects(
              insertRow(pool, `${service}:malformed`, { type: 'cotsel.notification' }),
              { code: '23514' },
              `${service}: an envelope without eventId, schemaVersion and payload is rejected`,
            );

            await assert.rejects(
              pool.query(
                `UPDATE notification_outbox SET envelope = jsonb_set(envelope, '{eventId}', '"evt-2"')
                 WHERE id = $1`,
                [id],
              ),
              { code: '23514' },
              `${service}: a written envelope cannot be rewritten`,
            );

            await pool.query(
              `UPDATE notification_outbox
               SET occurrences = occurrences + 1, last_seen_at = NOW()
               WHERE id = $1`,
              [id],
            );
            const afterMerge = await pool.query(
              'SELECT envelope, occurrences FROM notification_outbox WHERE id = $1',
              [id],
            );
            assert.equal(afterMerge.rows[0].occurrences, 2);
            assert.deepEqual(afterMerge.rows[0].envelope, ENVELOPE, `${service}: merge keeps it`);

            const legacy = await insertRow(pool, `${service}:legacy`, null);
            await pool.query('UPDATE notification_outbox SET envelope = $2::jsonb WHERE id = $1', [
              legacy,
              JSON.stringify({ ...ENVELOPE, eventId: 'evt-legacy' }),
            ]);
          } finally {
            await pool.end();
            await admin.query(`DROP DATABASE IF EXISTS ${database}`);
          }
        }
      } finally {
        await admin.query('DROP ROLE IF EXISTS cotsel_outbox_runtime');
        await admin.end();
      }
    });
  },
);
