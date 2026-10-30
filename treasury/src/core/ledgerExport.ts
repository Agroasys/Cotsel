/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { parseRawAmount } from './canonicalAmount';

/**
 * An export is a statement about the ledger at one instant. Without a fixed
 * cutoff, page two is drawn from a different ledger than page one, and rows
 * inserted mid-export are either duplicated or skipped depending on sort order.
 * Every page carries the same cutoff and snapshot totals. Continuation is
 * keyset rather than offset. Changed totals fail closed, but equal totals do
 * not establish that the candidate rows or their eligibility are unchanged.
 */
export const MAX_EXPORT_PAGE_SIZE = 1000;
export const DEFAULT_EXPORT_PAGE_SIZE = 500;

export class ExportRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExportRequestError';
    this.code = code;
  }
}

/**
 * Keyset position in the `created_at DESC, id DESC` ordering. The id breaks ties
 * between rows sharing a timestamp, which a timestamp-only cursor would either
 * re-emit or drop.
 */
export interface ExportCursor {
  createdAt: Date;
  id: number;
}

export interface ExportContinuationCursor extends ExportCursor {
  snapshot: ExportSnapshotTotals;
  scannedRowCount: number;
  scannedAmountRaw: string;
}

export interface ExportRequest {
  cutoff: Date;
  cursor: ExportContinuationCursor | null;
  limit: number;
  allowPartial: boolean;
}

export interface ExportSnapshotTotals {
  rowCount: number;
  totalAmountRaw: string;
}

export interface ExportPageInput<TEntry> {
  request: ExportRequest;
  snapshot: ExportSnapshotTotals;
  /** Candidate rows at or before the cutoff, already ordered and limited. */
  candidates: readonly TEntry[];
  /** True when the candidate query found at least one row beyond this page. */
  hasMore: boolean;
  selectExportable: (entry: TEntry) => boolean;
  readAmountRaw: (entry: TEntry) => string;
  readCursor: (entry: TEntry) => ExportCursor;
}

export interface ExportPage<TEntry> {
  cutoff: string;
  snapshot: ExportSnapshotTotals;
  scannedRowCount: number;
  exportedRowCount: number;
  exportedAmountRaw: string;
  nextCursor: string | null;
  complete: boolean;
  entries: TEntry[];
}

/**
 * The cutoff is part of the token, not just the query string. A cursor issued
 * under one cutoff continued against another would page across two different
 * snapshots, skipping or repeating rows while still reporting `complete`.
 */
function encodeCursor(
  cutoff: Date,
  cursor: ExportCursor,
  snapshot: ExportSnapshotTotals,
  scannedRowCount: number,
  scannedAmountRaw: string,
): string {
  return Buffer.from(
    `v2|${cutoff.toISOString()}|${cursor.createdAt.toISOString()}|${cursor.id}|${snapshot.rowCount}|${snapshot.totalAmountRaw}|${scannedRowCount}|${scannedAmountRaw}`,
    'utf8',
  ).toString('base64url');
}

function parseCursorCount(value: string, field: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ExportRequestError('InvalidCursor', `cursor ${field} is not a safe count`);
  }
  return Number(value);
}

function parseCursorAmount(value: string, field: string): string {
  if (value.length > 200 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ExportRequestError('InvalidCursor', `cursor ${field} is not a canonical amount`);
  }
  return value;
}

export function decodeCursor(value: unknown): ExportContinuationCursor & { cutoff: Date } {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ExportRequestError('InvalidCursor', 'cursor is not valid base64url');
  }
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new ExportRequestError('InvalidCursor', 'cursor is not valid base64url');
  }

  const parts = decoded.split('|');
  if (parts.length !== 8 || parts[0] !== 'v2') {
    throw new ExportRequestError('InvalidCursor', 'cursor is malformed');
  }

  const [rawCutoff, rawCreatedAt, rawId, rawRowCount, rawTotal, rawScannedCount, rawScannedAmount] =
    parts.slice(1);
  const cutoff = new Date(rawCutoff);
  const createdAt = new Date(rawCreatedAt);
  const id = Number(rawId);
  const rowCount = parseCursorCount(rawRowCount, 'row count');
  const totalAmountRaw = parseCursorAmount(rawTotal, 'total amount');
  const scannedRowCount = parseCursorCount(rawScannedCount, 'scanned row count');
  const scannedAmountRaw = parseCursorAmount(rawScannedAmount, 'scanned amount');

  if (Number.isNaN(cutoff.getTime())) {
    throw new ExportRequestError('InvalidCursor', 'cursor cutoff is not a valid date');
  }

  if (Number.isNaN(createdAt.getTime())) {
    throw new ExportRequestError('InvalidCursor', 'cursor timestamp is not a valid date');
  }

  if (!/^[1-9][0-9]*$/.test(rawId) || !Number.isSafeInteger(id)) {
    throw new ExportRequestError('InvalidCursor', 'cursor id is not a positive integer');
  }

  if (scannedRowCount > rowCount || BigInt(scannedAmountRaw) > BigInt(totalAmountRaw)) {
    throw new ExportRequestError('InvalidCursor', 'cursor scanned totals exceed the snapshot');
  }

  return {
    cutoff,
    createdAt,
    id,
    snapshot: { rowCount, totalAmountRaw },
    scannedRowCount,
    scannedAmountRaw,
  };
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_EXPORT_PAGE_SIZE;
  }

  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ExportRequestError('InvalidLimit', 'limit must be a positive integer');
  }

  // Clamping silently is what produced the original 5000-row truncation, so an
  // oversized request is refused instead of quietly shrunk.
  if (limit > MAX_EXPORT_PAGE_SIZE) {
    throw new ExportRequestError(
      'InvalidLimit',
      `limit ${limit} exceeds the maximum export page size of ${MAX_EXPORT_PAGE_SIZE}`,
    );
  }

  return limit;
}

function parseCutoff(raw: unknown, now: Date): Date {
  if (raw === undefined || raw === null || raw === '') {
    return now;
  }

  if (typeof raw !== 'string') {
    throw new ExportRequestError('InvalidCutoff', 'cutoff must be an ISO-8601 string');
  }

  const cutoff = new Date(raw);
  if (Number.isNaN(cutoff.getTime())) {
    throw new ExportRequestError('InvalidCutoff', 'cutoff must be an ISO-8601 string');
  }

  if (cutoff.getTime() > now.getTime()) {
    throw new ExportRequestError('InvalidCutoff', 'cutoff must not be in the future');
  }

  return cutoff;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (raw === undefined || raw === null || raw === '') {
    return false;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new ExportRequestError(`Invalid${field}`, `${field} must be 'true' or 'false'`);
}

export function parseExportRequest(
  query: Record<string, unknown>,
  now: Date = new Date(),
): ExportRequest {
  const cursor = query.cursor;
  if (cursor !== undefined && typeof cursor !== 'string') {
    throw new ExportRequestError('InvalidCursor', 'cursor must be a string');
  }

  const cutoff = parseCutoff(query.cutoff, now);
  const decoded = cursor ? decodeCursor(cursor) : null;

  // A continuation that changes the cutoff is a different export. The cutoff
  // must be restated, and it must be the one the cursor was issued under, so a
  // caller cannot stitch two snapshots into one file and call it complete.
  if (decoded && (query.cutoff === undefined || query.cutoff === '')) {
    throw new ExportRequestError(
      'MissingCutoff',
      'cutoff is required when continuing an export with a cursor',
    );
  }

  if (decoded && decoded.cutoff.getTime() !== cutoff.getTime()) {
    throw new ExportRequestError(
      'CutoffMismatch',
      `cursor was issued for cutoff ${decoded.cutoff.toISOString()} but the request supplied ${cutoff.toISOString()}`,
    );
  }

  return {
    cutoff,
    cursor: decoded
      ? {
          createdAt: decoded.createdAt,
          id: decoded.id,
          snapshot: decoded.snapshot,
          scannedRowCount: decoded.scannedRowCount,
          scannedAmountRaw: decoded.scannedAmountRaw,
        }
      : null,
    limit: parseLimit(query.limit),
    allowPartial: parseBoolean(query.allowPartial, 'AllowPartial'),
  };
}

export function buildExportPage<TEntry>(input: ExportPageInput<TEntry>): ExportPage<TEntry> {
  const baseline = input.request.cursor?.snapshot ?? input.snapshot;
  const snapshotChanged =
    input.snapshot.rowCount !== baseline.rowCount ||
    BigInt(input.snapshot.totalAmountRaw) !== BigInt(baseline.totalAmountRaw);
  const scannedRowCount = (input.request.cursor?.scannedRowCount ?? 0) + input.candidates.length;
  const scannedAmount =
    BigInt(input.request.cursor?.scannedAmountRaw ?? '0') +
    input.candidates.reduce(
      (total, entry) => total + parseRawAmount(input.readAmountRaw(entry), 'amountRaw'),
      0n,
    );
  if (
    snapshotChanged ||
    scannedRowCount > baseline.rowCount ||
    scannedAmount > BigInt(baseline.totalAmountRaw) ||
    (!input.hasMore &&
      (scannedRowCount !== baseline.rowCount || scannedAmount !== BigInt(baseline.totalAmountRaw)))
  ) {
    throw new ExportRequestError(
      'InconsistentExportSnapshot',
      'Ledger export snapshot changed while paging; restart the export with a new cutoff',
    );
  }

  const entries = input.candidates.filter((entry) => input.selectExportable(entry));
  const exportedAmountRaw = entries
    .reduce((total, entry) => total + parseRawAmount(input.readAmountRaw(entry), 'amountRaw'), 0n)
    .toString();

  const lastCandidate = input.candidates[input.candidates.length - 1];
  const nextCursor =
    input.hasMore && lastCandidate
      ? encodeCursor(
          input.request.cutoff,
          input.readCursor(lastCandidate),
          baseline,
          scannedRowCount,
          scannedAmount.toString(),
        )
      : null;

  return {
    cutoff: input.request.cutoff.toISOString(),
    snapshot: input.snapshot,
    scannedRowCount: input.candidates.length,
    exportedRowCount: entries.length,
    exportedAmountRaw,
    nextCursor,
    complete: nextCursor === null,
    entries,
  };
}

/**
 * CSV has no envelope to carry a continuation token, so an incomplete CSV page
 * is indistinguishable from a complete export once it is written to disk. That
 * is the failure mode this issue exists to remove, so it is refused outright
 * unless the caller states that a partial file is what they want. The legacy
 * HTTP endpoint applies a stricter rule and refuses every incomplete page.
 */
export function assertCompleteExportDelivery(
  page: ExportPage<unknown>,
  format: string,
  allowPartial: boolean,
): void {
  if (format !== 'csv' || page.complete || allowPartial) {
    return;
  }

  throw new ExportRequestError(
    'IncompleteExport',
    `CSV export would truncate at ${page.scannedRowCount} of ${page.snapshot.rowCount} rows. ` +
      'Page the export with the JSON format and its cursor, or pass allowPartial=true to accept a partial file.',
  );
}
