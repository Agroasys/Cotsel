/** SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  failure,
  HttpError,
  requireIsoTimestamp,
  requireObject,
  success,
} from '@agroasys/shared-http';
import { config } from '../config';
import { pool } from '../database/connection';
import { ExportJobConflict, ExportSnapshotStore } from '../database/exportSnapshotStore';
import { ExportSnapshotTokens, ExportTokenUnavailable } from '../database/exportSnapshotTokens';
import { ExportSnapshotBuilder } from '../core/exportSnapshotBuilder';
import type { AuthenticatedRequest } from '../core/actorIdentity';
import { Logger } from '../utils/logger';
import { sendTreasuryInternalFailure } from './errorMapping';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ACTIVE_BUILDS = 2;
const active = new Set<string>();
interface SnapshotPageRow {
  position: string | null;
  captured_row: Record<string, unknown> | null;
  eligibility: Record<string, unknown> | null;
}

function callerFor(req: Request): string {
  const principal = (req as AuthenticatedRequest).serviceAuth;
  if (!principal?.apiKeyId || principal.scheme !== 'api_key')
    throw new HttpError(401, 'ActorUnauthenticated', 'Authentication is required for exports');
  return createHash('sha256')
    .update(JSON.stringify([principal.apiKeyId, principal.humanPrincipalId ?? null]))
    .digest('hex');
}

function exportId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID.test(id))
    throw new HttpError(400, 'InvalidExportId', 'Invalid export ID');
  return id;
}

function pageLimit(value: unknown): number {
  if (value === undefined) return 500;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    throw new HttpError(400, 'InvalidLimit', 'limit must be a positive integer');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 1000)
    throw new HttpError(400, 'InvalidLimit', 'limit must not exceed 1000');
  return limit;
}

function sendError(req: Request, res: Response, error: unknown): void {
  if (error instanceof ExportTokenUnavailable) {
    res.status(404).json(failure('ExportNotFound', 'Export is unavailable'));
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.statusCode).json(failure(error.code, error.message));
    return;
  }
  if (error instanceof ExportJobConflict) {
    res.status(409).json(failure('IdempotencyConflict', error.message));
    return;
  }
  sendTreasuryInternalFailure(req, res, error, 'Export snapshot request failed');
}

export class ExportSnapshotsController {
  private readonly store = new ExportSnapshotStore();
  private readonly tokens = new ExportSnapshotTokens();
  private readonly builder = new ExportSnapshotBuilder();

  async create(req: Request, res: Response): Promise<void> {
    try {
      const caller = callerFor(req);
      const key = req.get('Idempotency-Key');
      if (!key || key.length > 255 || !/^[\x21-\x7e]+$/.test(key))
        throw new HttpError(400, 'InvalidIdempotencyKey', 'A valid Idempotency-Key is required');
      const body = requireObject(req.body, 'body');
      if (Object.keys(body).some((name) => name !== 'cutoff'))
        throw new HttpError(400, 'ValidationError', 'Unexpected export request field');
      const cutoff = requireIsoTimestamp(body.cutoff, 'cutoff');
      if (cutoff.getTime() > Date.now())
        throw new HttpError(400, 'InvalidCutoff', 'cutoff must not be in the future');
      const job = await this.store.create(caller, key, cutoff);
      if (job.status !== 'COMPLETE' && !active.has(job.id)) {
        if (active.size >= MAX_ACTIVE_BUILDS) {
          res
            .status(503)
            .json(
              failure('ExportCapacityExceeded', 'Retry this request with the same idempotency key'),
            );
          return;
        }
        active.add(job.id);
        setImmediate(() => {
          void this.builder
            .build(job.id, config.exportMaxRows)
            .catch(() => {
              Logger.error('Treasury export construction failed', { exportId: job.id });
            })
            .finally(() => active.delete(job.id));
        });
      }
      res.status(job.status === 'COMPLETE' ? 200 : 202).json(
        success({
          id: job.id,
          status: job.status,
          attempt: job.attempt,
          updatedAt: job.updated_at,
          cutoff: job.cutoff,
          accessExpiresAt: job.access_expires_at,
        }),
      );
    } catch (error) {
      sendError(req, res, error);
    }
  }

  async status(req: Request, res: Response): Promise<void> {
    try {
      const job = await this.store.get(callerFor(req), exportId(req));
      if (!job) throw new HttpError(404, 'ExportNotFound', 'Export is unavailable');
      res.status(200).json(
        success({
          id: job.id,
          status: job.status,
          cutoff: job.cutoff,
          accessExpiresAt: job.access_expires_at,
          attempt: job.attempt,
          updatedAt: job.updated_at,
          candidateCount: job.candidate_count,
          candidateAmountRaw: job.candidate_amount_raw,
          failureCode: job.failure_code,
          chainContext: job.status === 'COMPLETE' ? job.chain_context : null,
          reconciliationContext: job.status === 'COMPLETE' ? job.reconciliation_context : null,
          ingestionContext: job.status === 'COMPLETE' ? job.ingestion_context : null,
        }),
      );
    } catch (error) {
      sendError(req, res, error);
    }
  }

  async entries(req: Request, res: Response): Promise<void> {
    try {
      const caller = callerFor(req);
      const id = exportId(req);
      const limit = pageLimit(req.query.limit);
      const job = await this.store.get(caller, id);
      if (!job) throw new HttpError(404, 'ExportNotFound', 'Export is unavailable');
      if (job.status !== 'COMPLETE')
        throw new HttpError(409, 'ExportIncomplete', 'Export construction is not complete');
      const position =
        req.query.cursor === undefined
          ? 0
          : await this.tokens.resolve(caller, id, req.query.cursor);
      if (position === null)
        throw new HttpError(400, 'InvalidCursor', 'Export continuation is invalid or expired');
      const result = await pool.query<SnapshotPageRow>(
        `SELECT r.position::text, r.captured_row, r.eligibility FROM treasury_export_jobs j
         LEFT JOIN LATERAL (
           SELECT position, captured_row, eligibility FROM treasury_export_rows
           WHERE job_id=j.id AND attempt=j.attempt AND position >= $3 ORDER BY position LIMIT $4
         ) r ON TRUE
         WHERE j.id=$1 AND j.caller_id=$2 AND j.status='COMPLETE' AND j.access_expires_at > NOW()
         ORDER BY r.position`,
        [id, caller, position, limit + 1],
      );
      if (result.rows.length === 0)
        throw new HttpError(404, 'ExportNotFound', 'Export is unavailable');
      const available: SnapshotPageRow[] = result.rows.filter(
        (row: SnapshotPageRow) => row.position !== null,
      );
      const more = available.length > limit;
      const rows = more ? available.slice(0, limit) : available;
      const nextCursor = more
        ? await this.tokens.issue(caller, id, Number(rows[rows.length - 1].position) + 1)
        : null;
      res.status(200).json(
        success({
          id,
          cutoff: job.cutoff,
          candidateCount: job.candidate_count,
          candidateAmountRaw: job.candidate_amount_raw,
          scannedRowCount: rows.length,
          complete: !more,
          nextCursor,
          entries: rows.map((row) => ({ ...row.captured_row, ...row.eligibility })),
        }),
      );
    } catch (error) {
      sendError(req, res, error);
    }
  }
}
