/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-10 I-06 regression: the real indexer GraphQL client raises plain errors
 * that carry upstream text. Driven against a live HTTP endpoint, that failure
 * must reach the caller as `InternalError` with a correlation ID only.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';

process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

const UPSTREAM_TEXT =
  'relation "overview_snapshots" does not exist (provider https://indexer.internal.example/key-9f2)';

describe('treasury public errors with the real indexer client', () => {
  let server: Server;
  let graphqlUrl: string;
  let errorLog: jest.SpyInstance;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: UPSTREAM_TEXT }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    graphqlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  test('a GraphQL error from the indexer is answered as InternalError', async () => {
    const { IndexerClient } = await import('../src/indexer/client');
    const { sendMappedError } = await import('../src/api/errorMapping');

    const failure = await new IndexerClient(graphqlUrl)
      .fetchProcessedBlock()
      .then(() => new Error('expected the indexer request to fail'))
      .catch((error: unknown) => error);
    expect(String((failure as Error).message)).toContain('overview_snapshots');

    const res = {
      setHeader: jest.fn(),
      status: jest.fn(),
      json: jest.fn(),
    } as unknown as Response & { status: jest.Mock; json: jest.Mock };
    res.status.mockReturnValue(res);
    sendMappedError(
      { headers: { 'x-request-id': 'gateway-req-777777' } } as unknown as Request,
      res,
      failure,
      'Failed to read indexer state',
    );

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({ error: 'InternalError', correlationId: 'gateway-req-777777' });
    const serialized = JSON.stringify(body);
    for (const leaked of ['overview_snapshots', 'indexer.internal.example', 'key-9f2', 'GraphQL']) {
      expect(serialized).not.toContain(leaked);
    }
  });
});
