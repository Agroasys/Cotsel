/** SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../database/connection';
import { ExportSnapshotStore } from '../database/exportSnapshotStore';
import { capturedSourcesMatch } from '../database/exportSnapshotVerification';
import type { LedgerEntryForExport } from '../database/queries/ledger';
import { TreasuryEligibilityService } from './exportEligibility';
import { sameReconciliationGate } from './exportEligibilityContext';
import type { TradeReconciliationGate } from './reconciliationGate';

const BATCH_SIZE = 500;
const LEASE_SECONDS = 300;
const FAILURE_CODES: Record<string, string> = {
  'Captured ledger sources changed': 'SOURCE_CHANGED',
  'Finalized chain anchor changed or is unavailable': 'CHAIN_ANCHOR_CHANGED',
  'Finalized chain anchor is unavailable': 'CHAIN_ANCHOR_UNAVAILABLE',
  'Canonical chain evidence is unavailable': 'CANONICALITY_UNAVAILABLE',
  'Reconciliation evidence changed or became unavailable': 'RECONCILIATION_CHANGED',
  'Reconciliation run changed during export construction': 'RECONCILIATION_CHANGED',
  'Reconciliation evidence changed during export construction': 'RECONCILIATION_CHANGED',
  'Reconciliation evidence is unavailable or incomplete': 'RECONCILIATION_UNAVAILABLE',
  'Ingestion evidence changed or became stale': 'INGESTION_CHANGED',
  'Ingestion evidence is unavailable or stale': 'INGESTION_UNAVAILABLE',
  'Export build lease was lost': 'LEASE_LOST',
};

/** Builds a historical report. Financial actions must continue to use current eligibility. */
export class ExportSnapshotBuilder {
  private readonly store: ExportSnapshotStore;
  constructor(
    private readonly db: Pool = defaultPool,
    private readonly eligibility: TreasuryEligibilityService = new TreasuryEligibilityService(),
  ) {
    this.store = new ExportSnapshotStore(db);
  }

  async build(jobId: string, maxRows: number): Promise<boolean> {
    const owner = randomUUID();
    const job = await this.store.claim(jobId, owner, LEASE_SECONDS);
    if (!job) return false;
    try {
      await this.store.capture(jobId, owner, maxRows);
      const context = await this.eligibility.createSnapshotContext();
      let position = 0;
      for (;;) {
        await this.renew(jobId, owner);
        const page = await this.db.query<{ position: string; captured_row: LedgerEntryForExport }>(
          `SELECT r.position::text, r.captured_row FROM treasury_export_rows r
           WHERE r.job_id=$1 AND r.attempt=$2 AND r.position >= $3 ORDER BY r.position LIMIT $4`,
          [jobId, job.attempt, position, BATCH_SIZE],
        );
        if (page.rows.length === 0) break;
        const verdicts = await this.eligibility.assessEntries(
          page.rows.map((row) => row.captured_row),
          context,
        );
        const records = page.rows.map((row) => {
          const verdict = verdicts.get(row.captured_row.id);
          const reconciliationEvidence = context.reconciliationByTradeId.get(
            row.captured_row.trade_id,
          );
          if (!verdict || !reconciliationEvidence)
            throw new Error('Eligibility evidence is incomplete');
          if (verdict.canonicalityState !== 'CANONICAL' && verdict.canonicalityState !== 'ORPHANED')
            throw new Error('Canonical chain evidence is unavailable');
          const exportBlockedReasons = verdict.eligibleForExport
            ? []
            : verdict.eligibleForPayout
              ? ['Payout state is not eligible for export']
              : verdict.blockedReasons;
          if (!verdict.eligibleForExport && exportBlockedReasons.length === 0)
            throw new Error('Eligibility evidence is incomplete');
          return {
            position: Number(row.position),
            eligibility: { ...verdict, exportBlockedReasons, reconciliationEvidence },
          };
        });
        await this.renew(jobId, owner);
        const saved = await this.db.query(
          `UPDATE treasury_export_rows r SET eligibility=v.eligibility
           FROM jsonb_to_recordset($3::jsonb) AS v(position bigint, eligibility jsonb), treasury_export_jobs j
           WHERE r.job_id=$1 AND r.attempt=$2 AND r.position=v.position AND j.id=r.job_id
             AND j.attempt=r.attempt AND j.status='BUILDING' AND j.lease_owner=$4 AND j.lease_expires_at > clock_timestamp()`,
          [jobId, job.attempt, JSON.stringify(records), owner],
        );
        if (saved.rowCount !== records.length) throw new Error('Export build lease was lost');
        position = Number(page.rows[page.rows.length - 1].position) + 1;
      }
      if (!context.reconciliationRunKey) {
        await this.eligibility.establishEmptySnapshotContext(context);
        await this.eligibility.verifySnapshotContext(context);
      }
      position = 0;
      for (;;) {
        await this.renew(jobId, owner);
        const evidence = await this.db.query<{
          position: string;
          trade_id: string;
          gate: TradeReconciliationGate;
        }>(
          `SELECT r.position::text, r.captured_row->>'trade_id' AS trade_id,
                  r.eligibility->'reconciliationEvidence' AS gate
           FROM treasury_export_rows r WHERE r.job_id=$1 AND r.attempt=$2 AND r.position >= $3
           ORDER BY r.position LIMIT $4`,
          [jobId, job.attempt, position, BATCH_SIZE],
        );
        if (evidence.rows.length === 0) break;
        context.reconciliationByTradeId.clear();
        for (const row of evidence.rows) {
          const previous = context.reconciliationByTradeId.get(row.trade_id);
          if (!row.gate || (previous && !sameReconciliationGate(previous, row.gate))) {
            throw new Error('Reconciliation evidence changed during export construction');
          }
          context.reconciliationByTradeId.set(row.trade_id, row.gate);
        }
        await this.eligibility.verifySnapshotContext(context);
        position = Number(evidence.rows[evidence.rows.length - 1].position) + 1;
      }
      await this.renew(jobId, owner);
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query(
          `SELECT id FROM treasury_export_jobs WHERE id=$1 AND status='BUILDING' AND attempt=$2
           AND lease_owner=$3 AND lease_expires_at > clock_timestamp() FOR UPDATE`,
          [jobId, job.attempt, owner],
        );
        if (locked.rowCount !== 1) throw new Error('Export build lease was lost');
        if (!(await capturedSourcesMatch(client, jobId, job.attempt, job.cutoff)))
          throw new Error('Captured ledger sources changed');
        const completed = await client.query(
          `UPDATE treasury_export_jobs SET status='COMPLETE', completed_at=clock_timestamp(), lease_owner=NULL,
           lease_expires_at=NULL, chain_context=$3::jsonb, reconciliation_context=$4::jsonb,
           ingestion_context=$5::jsonb, updated_at=clock_timestamp()
           WHERE id=$1 AND lease_owner=$2 AND lease_expires_at > clock_timestamp()`,
          [
            jobId,
            owner,
            JSON.stringify({ ...context.heads, finalizedBlockHash: context.finalizedBlockHash }),
            JSON.stringify({
              runKey: context.reconciliationRunKey,
              emptyRunAnchor: context.emptyRunAnchor ?? null,
            }),
            JSON.stringify(context.ingestion),
          ],
        );
        if (completed.rowCount !== 1) throw new Error('Export build lease was lost');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return true;
    } catch (error) {
      await this.db.query(
        `UPDATE treasury_export_jobs SET status='FAILED', failure_code=$3, lease_owner=NULL,
         lease_expires_at=NULL, updated_at=NOW() WHERE id=$1 AND status='BUILDING' AND lease_owner=$2`,
        [
          jobId,
          owner,
          error instanceof Error
            ? (FAILURE_CODES[error.message] ?? 'CONSTRUCTION_FAILED')
            : 'CONSTRUCTION_FAILED',
        ],
      );
      throw error;
    }
  }

  private async renew(jobId: string, owner: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE treasury_export_jobs SET lease_expires_at=clock_timestamp() + ($3 * interval '1 second'), updated_at=clock_timestamp()
       WHERE id=$1 AND status='BUILDING' AND lease_owner=$2 AND lease_expires_at > clock_timestamp()`,
      [jobId, owner, LEASE_SECONDS],
    );
    if (result.rowCount !== 1) throw new Error('Export build lease was lost');
  }
}
