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
  const snapshot = hasMore
    ? { rowCount: 9, totalAmountRaw: '9000' }
    : {
        rowCount: rows.length,
        totalAmountRaw: rows
          .reduce((total, entry) => total + BigInt(entry.amount_raw), 0n)
          .toString(),
      };
  return buildExportPage({
    request: {
      cutoff: NOW,
      cursor: null,
      limit: overrides.limit ?? DEFAULT_EXPORT_PAGE_SIZE,
      allowPartial: false,
    },
    snapshot,
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
    const emitted = page([row(1, '100'), row(2, '200')], true).nextCursor as string;
    expect(() => parseExportRequest({ cursor: emitted }, NOW)).toThrow(/cutoff is required/);
  });

  it('accepts a cursor continued under the cutoff it was issued for', () => {
    const emitted = page([row(1, '100'), row(2, '200')], true).nextCursor as string;
    const request = parseExportRequest({ cursor: emitted, cutoff: NOW.toISOString() }, NOW);
    expect(request.cursor).toEqual({ createdAt: new Date('2026-09-17T10:02:00.000Z'), id: 2 });
  });

  it('rejects a cursor continued under a different cutoff', () => {
    // Paging one snapshot's cursor against another silently skips or repeats
    // rows while every page still reports itself complete.
    const emitted = page([row(1, '100'), row(2, '200')], true).nextCursor as string;
    expect(() =>
      parseExportRequest({ cursor: emitted, cutoff: '2026-09-17T11:00:00.000Z' }, NOW),
    ).toThrow(/cursor was issued for cutoff/);
  });

  it.each([
    ['not base64url', '!!!'],
    ['missing separators', Buffer.from('nope', 'utf8').toString('base64url')],
    [
      'missing the cutoff segment',
      Buffer.from('2026-09-17T10:01:00.000Z|1', 'utf8').toString('base64url'),
    ],
    ['a bad cutoff', Buffer.from('nope|2026-09-17T10:01:00.000Z|1', 'utf8').toString('base64url')],
    ['a bad timestamp', Buffer.from(`${NOW.toISOString()}|nope|1`, 'utf8').toString('base64url')],
    [
      'a bad id',
      Buffer.from(`${NOW.toISOString()}|2026-09-17T10:01:00.000Z|0`, 'utf8').toString('base64url'),
    ],
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
  it('round-trips a cursor emitted by a page, carrying its cutoff', () => {
    const emitted = page([row(1, '100'), row(2, '200')], true).nextCursor as string;
    expect(decodeCursor(emitted)).toEqual({
      cutoff: NOW,
      createdAt: new Date('2026-09-17T10:02:00.000Z'),
      id: 2,
    });
  });
});

describe('buildExportPage', () => {
  it('reports the cutoff, snapshot totals and per-page totals', () => {
    const result = page([row(1, '100'), row(2, '250')], false);
    expect(result.cutoff).toBe(NOW.toISOString());
    expect(result.snapshot).toEqual({ rowCount: 2, totalAmountRaw: '350' });
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

  it.each([
    [{ rowCount: 0, totalAmountRaw: '0' }, [row(1, '100')]],
    [{ rowCount: 2, totalAmountRaw: '200' }, [row(1, '100')]],
    [{ rowCount: 1, totalAmountRaw: '200' }, [row(1, '100')]],
  ])('refuses a completed page inconsistent with its snapshot', (snapshot, candidates) => {
    expect(() =>
      buildExportPage({
        request: { cutoff: NOW, cursor: null, limit: 1000, allowPartial: false },
        snapshot,
        candidates,
        hasMore: false,
        selectExportable: (entry) => entry.eligibleForExport,
        readAmountRaw: (entry) => entry.amount_raw,
        readCursor: (entry) => ({ createdAt: entry.created_at, id: entry.id }),
      }),
    ).toThrow(/snapshot changed/);
  });

  it('continues through more than 5,000 same-timestamp rows exactly once', () => {
    const allRows: Row[] = Array.from({ length: 5001 }, (_, index) => ({
      id: 5001 - index,
      created_at: new Date('2026-09-17T10:00:00.000Z'),
      amount_raw: '1',
      eligibleForExport: true,
    }));
    const seen: number[] = [];
    let exportedAmount = 0n;
    let request = parseExportRequest({ cutoff: NOW.toISOString(), limit: '1000' }, NOW);

    for (let pageNumber = 0; pageNumber < 6; pageNumber += 1) {
      const remaining = allRows.filter((entry) => !request.cursor || entry.id < request.cursor.id);
      const result = buildExportPage({
        request,
        snapshot: { rowCount: 5001, totalAmountRaw: '5001' },
        candidates: remaining.slice(0, request.limit),
        hasMore: remaining.length > request.limit,
        selectExportable: (entry) => entry.eligibleForExport,
        readAmountRaw: (entry) => entry.amount_raw,
        readCursor: (entry) => ({ createdAt: entry.created_at, id: entry.id }),
      });
      seen.push(...result.entries.map((entry) => entry.id));
      exportedAmount += BigInt(result.exportedAmountRaw);

      if (result.nextCursor === null) {
        expect(result.complete).toBe(true);
        break;
      }
      expect(result.complete).toBe(false);
      request = parseExportRequest(
        { cutoff: NOW.toISOString(), cursor: result.nextCursor, limit: '1000' },
        NOW,
      );
    }

    expect(seen).toHaveLength(5001);
    expect(new Set(seen).size).toBe(5001);
    expect(seen[0]).toBe(5001);
    expect(seen[5000]).toBe(1);
    expect(exportedAmount).toBe(5001n);
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
