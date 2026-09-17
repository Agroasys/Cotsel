import {
  assertCompleteExportDelivery,
  buildExportPage,
  DEFAULT_EXPORT_PAGE_SIZE,
  decodeCursor,
  ExportRequestError,
  MAX_EXPORT_PAGE_SIZE,
  parseExportRequest,
} from '../src/core/ledgerExport';

const NOW = new Date('2026-09-17T12:00:00.000Z');

interface Row {
  id: number;
  created_at: Date;
  amount_raw: string;
  eligibleForExport: boolean;
}

function row(id: number, amountRaw: string, eligible = true): Row {
  return {
    id,
    created_at: new Date(`2026-09-17T10:0${id}:00.000Z`),
    amount_raw: amountRaw,
    eligibleForExport: eligible,
  };
}

function page(rows: Row[], hasMore: boolean, overrides: Partial<{ limit: number }> = {}) {
  return buildExportPage({
    request: {
      cutoff: NOW,
      cursor: null,
      limit: overrides.limit ?? DEFAULT_EXPORT_PAGE_SIZE,
      allowPartial: false,
    },
    snapshot: { rowCount: 9, totalAmountRaw: '9000' },
    candidates: rows,
    hasMore,
    selectExportable: (entry) => entry.eligibleForExport,
    readAmountRaw: (entry) => entry.amount_raw,
    readCursor: (entry) => ({ createdAt: entry.created_at, id: entry.id }),
  });
}

describe('parseExportRequest', () => {
  it('defaults to a now cutoff, no cursor and the default page size', () => {
    const request = parseExportRequest({}, NOW);
    expect(request.cutoff).toEqual(NOW);
    expect(request.cursor).toBeNull();
    expect(request.limit).toBe(DEFAULT_EXPORT_PAGE_SIZE);
    expect(request.allowPartial).toBe(false);
  });

  it('refuses an oversized limit rather than silently clamping it', () => {
    expect(() => parseExportRequest({ limit: String(MAX_EXPORT_PAGE_SIZE + 1) }, NOW)).toThrow(
      /exceeds the maximum export page size/,
    );
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects the limit %s', (limit) => {
    expect(() => parseExportRequest({ limit }, NOW)).toThrow(ExportRequestError);
  });

  it('rejects a future cutoff', () => {
    expect(() => parseExportRequest({ cutoff: '2026-09-18T00:00:00.000Z' }, NOW)).toThrow(
      /must not be in the future/,
    );
  });

  it('rejects a malformed cutoff', () => {
    expect(() => parseExportRequest({ cutoff: 'yesterday' }, NOW)).toThrow(/ISO-8601/);
  });

  it('requires the cutoff to be restated when continuing with a cursor', () => {
    const cursor = Buffer.from('2026-09-17T10:01:00.000Z|1', 'utf8').toString('base64url');
    expect(() => parseExportRequest({ cursor }, NOW)).toThrow(/cutoff is required/);
  });

  it('accepts a cursor when the cutoff is restated', () => {
    const cursor = Buffer.from('2026-09-17T10:01:00.000Z|1', 'utf8').toString('base64url');
    const request = parseExportRequest({ cursor, cutoff: '2026-09-17T11:00:00.000Z' }, NOW);
    expect(request.cursor).toEqual({ createdAt: new Date('2026-09-17T10:01:00.000Z'), id: 1 });
  });

  it.each([
    ['not base64url', '!!!'],
    ['missing separator', Buffer.from('nope', 'utf8').toString('base64url')],
    ['bad timestamp', Buffer.from('nope|1', 'utf8').toString('base64url')],
    ['bad id', Buffer.from('2026-09-17T10:01:00.000Z|0', 'utf8').toString('base64url')],
  ])('rejects a cursor that is %s', (_label, cursor) => {
    expect(() => parseExportRequest({ cursor, cutoff: NOW.toISOString() }, NOW)).toThrow(
      ExportRequestError,
    );
  });

  it.each(['yes', '1', 'TRUE'])('rejects the non-boolean allowPartial %s', (allowPartial) => {
    expect(() => parseExportRequest({ allowPartial }, NOW)).toThrow(/must be 'true' or 'false'/);
  });
});

describe('decodeCursor', () => {
  it('round-trips a cursor emitted by a page', () => {
    const emitted = page([row(1, '100'), row(2, '200')], true).nextCursor as string;
    expect(decodeCursor(emitted)).toEqual({
      createdAt: new Date('2026-09-17T10:02:00.000Z'),
      id: 2,
    });
  });
});

describe('buildExportPage', () => {
  it('reports the cutoff, snapshot totals and per-page totals', () => {
    const result = page([row(1, '100'), row(2, '250')], false);
    expect(result.cutoff).toBe(NOW.toISOString());
    expect(result.snapshot).toEqual({ rowCount: 9, totalAmountRaw: '9000' });
    expect(result.scannedRowCount).toBe(2);
    expect(result.exportedRowCount).toBe(2);
    expect(result.exportedAmountRaw).toBe('350');
  });

  it('marks the export complete and emits no cursor on the final page', () => {
    const result = page([row(1, '100')], false);
    expect(result.complete).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it('emits a continuation cursor from the last candidate, not the last exported row', () => {
    // Row 2 is ineligible, so a cursor taken from the exported rows would
    // re-scan it forever. Continuation must advance over every candidate.
    const result = page([row(1, '100'), row(2, '200', false)], true);
    expect(result.exportedRowCount).toBe(1);
    expect(result.scannedRowCount).toBe(2);
    expect(decodeCursor(result.nextCursor as string).id).toBe(2);
  });

  it('counts scanned candidates separately from exported rows so pages reconcile', () => {
    const result = page([row(1, '100'), row(2, '200', false), row(3, '300')], false);
    expect(result.scannedRowCount).toBe(3);
    expect(result.exportedRowCount).toBe(2);
    expect(result.exportedAmountRaw).toBe('400');
  });

  it('totals exactly beyond floating-point integer precision', () => {
    const result = page([row(1, '9007199254740993'), row(2, '1')], false);
    expect(result.exportedAmountRaw).toBe('9007199254740994');
  });

  it('returns a zero total for a page with no eligible rows', () => {
    const result = page([row(1, '100', false)], false);
    expect(result.exportedRowCount).toBe(0);
    expect(result.exportedAmountRaw).toBe('0');
  });

  it('rejects a non-canonical amount rather than exporting it', () => {
    expect(() => page([row(1, '')], false)).toThrow(/not a canonical treasury amount/);
  });
});

describe('assertCompleteExportDelivery', () => {
  it('allows a complete CSV export', () => {
    expect(() =>
      assertCompleteExportDelivery(page([row(1, '100')], false), 'csv', false),
    ).not.toThrow();
  });

  it('refuses a CSV export that would truncate', () => {
    expect(() => assertCompleteExportDelivery(page([row(1, '100')], true), 'csv', false)).toThrow(
      /would truncate at 1 of 9 rows/,
    );
  });

  it('allows a truncating CSV export when the caller opts in explicitly', () => {
    expect(() =>
      assertCompleteExportDelivery(page([row(1, '100')], true), 'csv', true),
    ).not.toThrow();
  });

  it('allows an incomplete JSON page because it carries its own cursor', () => {
    expect(() =>
      assertCompleteExportDelivery(page([row(1, '100')], true), 'json', false),
    ).not.toThrow();
  });
});
