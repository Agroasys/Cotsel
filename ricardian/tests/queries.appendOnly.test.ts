const mockPoolQuery = jest.fn();

jest.mock('../src/database/connection', () => ({
  pool: {
    query: mockPoolQuery,
  },
}));

import { createRicardianHash } from '../src/database/queries';
import { DocumentConflictError } from '../src/errors';

const input = {
  requestId: 'req-retry',
  documentRef: 'doc://trade-1',
  hash: 'a'.repeat(64),
  rulesVersion: 'RICARDIAN_CANONICAL_V1',
  canonicalJson: '{"documentRef":"doc://trade-1","metadata":{"orderId":1}}',
  metadata: { orderId: 1 },
};

const existingRow = {
  id: 7,
  request_id: 'req-original',
  document_ref: input.documentRef,
  hash: input.hash,
  rules_version: input.rulesVersion,
  canonical_json: input.canonicalJson,
  metadata: input.metadata,
  created_at: new Date('2026-07-26T12:00:00.000Z'),
};

describe('Ricardian registry append-only writes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('inserts without an update conflict branch', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [existingRow] });

    await expect(createRicardianHash(input)).resolves.toBe(existingRow);

    const sql = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('ON CONFLICT (hash, document_ref)');
    expect(sql).toContain('DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
  });

  test('returns immutable history for an identical retry', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existingRow] });

    await expect(
      createRicardianHash({
        ...input,
        requestId: 'req-new-retry',
      }),
    ).resolves.toBe(existingRow);
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  test('rejects a retry that conflicts with canonical history', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          ...existingRow,
          canonical_json: '{"tampered":true}',
          metadata: { orderId: 999 },
        },
      ],
    });

    await expect(createRicardianHash(input)).rejects.toBeInstanceOf(DocumentConflictError);
  });
});
