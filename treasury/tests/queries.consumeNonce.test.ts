const mockPoolQuery = jest.fn();

jest.mock('../src/database/connection', () => ({
  pool: {
    query: mockPoolQuery,
  },
}));

import { consumeServiceAuthNonce } from '../src/database/queries';

describe('treasury consumeServiceAuthNonce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('prunes expired nonces globally before atomic consume', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ accepted: true }] });

    const accepted = await consumeServiceAuthNonce('svc-a', 'nonce-1', 60);

    expect(accepted).toBe(true);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);

    const sql = mockPoolQuery.mock.calls[0][0] as string;
    const params = mockPoolQuery.mock.calls[0][1] as unknown[];

    expect(sql).toContain('DELETE FROM "treasury_auth_nonces"');
    expect(sql).toContain('WHERE "expires_at" <= NOW()');
    expect(sql).not.toContain('WHERE api_key = $1');
    expect(sql).toContain('ON CONFLICT ("api_key", "nonce") DO NOTHING');
    expect(params).toEqual(['svc-a', 'nonce-1', 60]);
  });

  test('throws for non-positive ttl before querying database', async () => {
    await expect(consumeServiceAuthNonce('svc-a', 'nonce-1', 0)).rejects.toThrow(
      'nonce ttlSeconds must be a positive integer',
    );

    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
