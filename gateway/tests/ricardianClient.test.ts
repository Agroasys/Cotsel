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

  test('fails closed when upstream success payload is missing required document fields', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          success: true,
          data: {
            hash: '0xabc',
            documentRef: 'doc-1',
          },
        }),
      ),
    });

    const client = new RicardianClient('https://ricardian.example/api/v1', 5000);

    await expect(client.getDocument('0xabc')).rejects.toMatchObject({
      statusCode: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Ricardian service returned an invalid payload',
    });
  });

  test('registers an immutable document through the Ricardian write route', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          success: true,
          data: {
            id: 7,
            requestId: 'order-42-v1',
            documentRef: 'agroasys-order:42:terms:1',
            hash: 'a'.repeat(64),
            rulesVersion: 'RICARDIAN_CANONICAL_V1',
            canonicalJson: '{}',
            metadata: { orderId: 42 },
            createdAt: '2026-07-26T00:00:00.000Z',
          },
        }),
      ),
    });

    const client = new RicardianClient('https://ricardian.example/api/v1', 5000);
    const document = await client.registerDocument({
      requestId: 'order-42-v1',
      documentRef: 'agroasys-order:42:terms:1',
      terms: { total: 1250 },
      metadata: { orderId: 42 },
    });

    expect(document.hash).toBe('a'.repeat(64));
    expect(global.fetch).toHaveBeenCalledWith(
      'https://ricardian.example/api/v1/hash',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          requestId: 'order-42-v1',
          documentRef: 'agroasys-order:42:terms:1',
          terms: { total: 1250 },
          metadata: { orderId: 42 },
        }),
      }),
    );
  });
});
