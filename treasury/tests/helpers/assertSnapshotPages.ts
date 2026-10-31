import type { Request, Response } from 'express';
import type { ExportSnapshotsController } from '../../src/api/exportSnapshots';

export async function assertEligibleSnapshotPages(
  controller: ExportSnapshotsController,
  jobId: string,
) {
  const eligibleSeen = new Set<number>();
  let eligibleTotal = 0n;
  let eligibleCursor: string | undefined;
  do {
    const pageStatus = jest.fn().mockReturnThis();
    const pageJson = jest.fn().mockReturnThis();
    await controller.entries(
      {
        params: { id: jobId },
        query: { limit: '1000', ...(eligibleCursor ? { cursor: eligibleCursor } : {}) },
        serviceAuth: { apiKeyId: 'svc', scheme: 'api_key' },
      } as unknown as Request,
      { status: pageStatus, json: pageJson } as unknown as Response,
    );
    expect(pageStatus).toHaveBeenCalledWith(200);
    const page = pageJson.mock.calls[0][0].data as {
      entries: Array<{
        id: number;
        amount_raw: string;
        eligibleForExport: boolean;
        exportBlockedReasons: string[];
      }>;
      nextCursor: string | null;
    };
    expect(page.entries.length).toBeLessThanOrEqual(1000);
    for (const row of page.entries) {
      expect(row.eligibleForExport).toBe(true);
      expect(row.exportBlockedReasons).toEqual([]);
      expect(eligibleSeen.has(row.id)).toBe(false);
      eligibleSeen.add(row.id);
      eligibleTotal += BigInt(row.amount_raw);
    }
    eligibleCursor = page.nextCursor ?? undefined;
  } while (eligibleCursor);
  return { eligibleSeen, eligibleTotal };
}
