import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { runVersionedMigrations } from '@agroasys/shared-db/migrate';

const enabled = process.env.RECONCILIATION_LOCAL_POSTGRES_TESTS === 'true';
test(
  'published reconciliation evidence is immutable and readable without write grants',
  { skip: !enabled },
  async () => {
    const suffix = randomBytes(6).toString('hex');
    const database = `recon_evidence_${suffix}`;
    const role = `recon_reader_${suffix}`;
    const connection = { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres' };
    const admin = new Pool({ ...connection, database: 'postgres' });
    let db: Pool | undefined;
    try {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
      await admin.query(`CREATE DATABASE "${database}"`);
      db = new Pool({ ...connection, database, options: '-c app.service_name=reconciliation' });
      await runVersionedMigrations({
        pool: db,
        serviceName: 'reconciliation',
        manifestPath: path.resolve(__dirname, '../database/migrations.json'),
        runtimeDbUser: 'postgres',
      });
      const seed = await db.query(
        "INSERT INTO reconcile_runs (run_key, mode, status, lease_owner, lease_expires_at) VALUES ('published', 'ONCE', 'RUNNING', 'owner', NOW() + interval '1 minute') RETURNING id",
      );
      const id = seed.rows[0].id;
      await db.query(
        "INSERT INTO reconcile_run_trades (run_id, run_key, trade_id) VALUES ($1, 'published', '1')",
        [id],
      );
      await db.query(
        "UPDATE reconcile_runs SET status='COMPLETED', completed_at=NOW(), coverage_complete=true, coverage_to_block=4242 WHERE id=$1",
        [id],
      );
      await assert.rejects(
        db.query('UPDATE reconcile_runs SET total_trades=9 WHERE id=$1', [id]),
        /reconcile_published_evidence_is_immutable/,
      );
      await assert.rejects(
        db.query('DELETE FROM reconcile_run_trades WHERE run_id=$1', [id]),
        /reconcile_published_evidence_is_immutable/,
      );
      await assert.rejects(
        db.query(
          "INSERT INTO reconcile_drifts (run_id, run_key, trade_id, severity, mismatch_code) VALUES ($1, 'published', '1', 'CRITICAL', 'NEW_DRIFT')",
          [id],
        ),
        /reconcile_published_evidence_is_immutable/,
      );
      await assert.rejects(db.query('TRUNCATE reconcile_drifts'), /reconcile_evidence_is_retained/);
      await db.query(
        'UPDATE reconcile_runs SET lease_owner=NULL, lease_expires_at=NULL WHERE id=$1',
        [id],
      );
      await db.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await db.query(
        `GRANT SELECT ON reconcile_runs, reconcile_run_trades, reconcile_drifts TO "${role}"`,
      );
      const reader = await db.connect();
      try {
        await reader.query(`SET ROLE "${role}"`);
        await reader.query('BEGIN READ ONLY');
        assert.equal(
          (await reader.query('SELECT reconciliation_export_evidence_version() AS version')).rows[0]
            .version,
          1,
        );
        assert.equal(
          (
            await reader.query('SELECT export_evidence_version FROM reconcile_runs WHERE id=$1', [
              id,
            ])
          ).rows[0].export_evidence_version,
          1,
        );
        await reader.query('COMMIT');
        await assert.rejects(
          reader.query('UPDATE reconcile_runs SET total_trades=9 WHERE id=$1', [id]),
          /permission denied/,
        );
      } finally {
        await reader.query('RESET ROLE');
        reader.release();
      }

      await assert.rejects(
        db.query('DELETE FROM reconcile_runs WHERE id=$1', [id]),
        /reconcile_published_evidence_is_immutable/,
      );
      await assert.rejects(
        db.query("UPDATE reconcile_run_trades SET trade_id='2' WHERE run_id=$1", [id]),
        /reconcile_published_evidence_is_immutable/,
      );
      await assert.rejects(
        db.query(
          "INSERT INTO reconcile_run_trades (run_id, run_key, trade_id) VALUES ($1, 'published', '2')",
          [id],
        ),
        /reconcile_published_evidence_is_immutable/,
      );
      const next = await db.query(
        "INSERT INTO reconcile_runs (run_key, mode, status) VALUES ('racing', 'ONCE', 'RUNNING') RETURNING id",
      );
      const nextId = next.rows[0].id;
      await assert.rejects(
        db.query(
          "INSERT INTO reconcile_drifts (run_id, run_key, trade_id, severity, mismatch_code) VALUES ($1, 'other-key', '1', 'CRITICAL', 'NEW_DRIFT')",
          [nextId],
        ),
        /reconcile_evidence_parent_mismatch/,
      );
      const writer = await db.connect();
      const publisher = await db.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          "INSERT INTO reconcile_run_trades (run_id, run_key, trade_id) VALUES ($1, 'racing', '3')",
          [nextId],
        );
        const pid = (await publisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let published = false;
        const publication = publisher
          .query("UPDATE reconcile_runs SET status='COMPLETED', completed_at=NOW() WHERE id=$1", [
            nextId,
          ])
          .then(() => {
            published = true;
          });
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          blocked = (
            await db.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])
          ).rows[0].blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(blocked, true, 'publication must wait for the child evidence writer');
        assert.equal(published, false);
        await writer.query('COMMIT');
        await publication;
        await assert.rejects(
          db.query('DELETE FROM reconcile_run_trades WHERE run_id=$1', [nextId]),
          /reconcile_published_evidence_is_immutable/,
        );
        assert.equal(
          (await db.query('SELECT count(*) FROM reconcile_run_trades WHERE run_id=$1', [nextId]))
            .rows[0].count,
          '1',
        );
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
        publisher.release();
      }
      await db.query(
        'ALTER TABLE reconcile_drifts DISABLE TRIGGER reconcile_published_child_guard',
      );
      assert.equal(
        (await db.query('SELECT reconciliation_export_evidence_version() AS version')).rows[0]
          .version,
        null,
      );
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  },
);
