/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { formatRawAmount, parseRawAmount } from './canonicalAmount';

/**
 * An export is a statement about the ledger at one instant. Without a fixed
 * cutoff, page two is drawn from a different ledger than page one, and rows
 * inserted mid-export are either duplicated or skipped depending on sort order.
 * Every page of one export therefore carries the same cutoff, and continuation
 * is keyset rather than offset so concurrent inserts cannot shift a page.
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

export interface ExportRequest {
  cutoff: Date;
  cursor: ExportCursor | null;
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
function encodeCursor(cutoff: Date, cursor: ExportCursor): string {
  return Buffer.from(
    `${cutoff.toISOString()}|${cursor.createdAt.toISOString()}|${cursor.id}`,
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(value: string): ExportCursor & { cutoff: Date } {
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new ExportRequestError('InvalidCursor', 'cursor is not valid base64url');
  }

  const parts = decoded.split('|');
  if (parts.length !== 3) {
    throw new ExportRequestError('InvalidCursor', 'cursor is malformed');
  }

  const [rawCutoff, rawCreatedAt, rawId] = parts;
  const cutoff = new Date(rawCutoff);
  const createdAt = new Date(rawCreatedAt);
  const id = Number(rawId);

  if (Number.isNaN(cutoff.getTime())) {
    throw new ExportRequestError('InvalidCursor', 'cursor cutoff is not a valid date');
  }

  if (Number.isNaN(createdAt.getTime())) {
    throw new ExportRequestError('InvalidCursor', 'cursor timestamp is not a valid date');
  }

  if (!Number.isInteger(id) || id <= 0) {
    throw new ExportRequestError('InvalidCursor', 'cursor id is not a positive integer');
  }

  return { cutoff, createdAt, id };
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
    cursor: decoded ? { createdAt: decoded.createdAt, id: decoded.id } : null,
    limit: parseLimit(query.limit),
    allowPartial: parseBoolean(query.allowPartial, 'AllowPartial'),
  };
}

export function buildExportPage<TEntry>(input: ExportPageInput<TEntry>): ExportPage<TEntry> {
  const entries = input.candidates.filter((entry) => input.selectExportable(entry));
  const exportedAmountRaw = formatRawAmount(
    entries.reduce(
      (total, entry) => total + parseRawAmount(input.readAmountRaw(entry), 'amountRaw'),
      0n,
    ),
    'exportedAmountRaw',
  );

  const lastCandidate = input.candidates[input.candidates.length - 1];
  const nextCursor =
    input.hasMore && lastCandidate
      ? encodeCursor(input.request.cutoff, input.readCursor(lastCandidate))
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
 * unless the caller states that a partial file is what they want.
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
