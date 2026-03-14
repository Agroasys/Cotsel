/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { RicardianClient } from '../src/core/ricardianClient';

describe('ricardian client', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('preserves not-found semantics when the upstream returns a non-JSON 404 body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 404,
      ok: false,
      text: jest.fn().mockResolvedValue('not found'),
    });

    const client = new RicardianClient('https://ricardian.example/api/v1', 5000);

    await expect(client.getDocument('missing-hash')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });
});
