/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { RicardianClient } from '../src/modules/ricardianClient';

describe('RicardianClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('generateHash posts payload and returns typed response', async () => {
    const client = new RicardianClient({ baseUrl: 'http://localhost:3100' });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          id: 1,
          requestId: 'req-1',
          documentRef: 'doc://ref',
          hash: 'a'.repeat(64),
          rulesVersion: 'RICARDIAN_CANONICAL_V1',
          canonicalJson: '{"x":1}',
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      }),
    } as Response);

    const result = await client.generateHash({
      documentRef: 'doc://ref',
      terms: { x: 1 },
    });

    expect(result.hash).toHaveLength(64);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3100/api/ricardian/v1/hash',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('getHash throws on API failure', async () => {
    const client = new RicardianClient({ baseUrl: 'http://localhost:3100' });

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        success: false,
        error: 'Hash not found',
      }),
    } as Response);

    await expect(client.getHash('f'.repeat(64))).rejects.toThrow('Hash not found');
  });
});
