/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  createDownstreamServiceRegistry,
  type DownstreamServiceContract,
} from '../src/core/serviceRegistry';
import { ServiceOrchestrator } from '../src/core/serviceOrchestrator';

function createContract(
  overrides: Partial<DownstreamServiceContract> = {},
): DownstreamServiceContract {
  return {
    key: 'treasury',
    name: 'Treasury',
    source: 'treasury_http',
    baseUrl: 'https://treasury.example',
    healthPath: '/api/treasury/v1/health',
    auth: {
      mode: 'shared_hmac',
      headerStyle: 'agroasys',
      apiKey: 'svc-key',
      apiSecret: 'svc-secret',
    },
    readTimeoutMs: 50,
    mutationTimeoutMs: 50,
    readRetryBudget: 1,
    mutationRetryBudget: 0,
    ...overrides,
  };
}

describe('service orchestrator', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test('propagates correlation headers and regenerates signed service auth headers on read retries', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' } as Response);
    global.fetch = fetchMock;

    const orchestrator = new ServiceOrchestrator(
      createDownstreamServiceRegistry([createContract()]),
    );

    const response = await orchestrator.fetch('treasury', {
      method: 'GET',
      path: '/api/treasury/v1/entries',
      query: { tradeId: 'TRD-1' },
      readOnly: true,
      authenticated: true,
      operation: 'treasury:listEntries',
      requestContext: { requestId: 'req-123', correlationId: 'corr-123' },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;

    expect(firstHeaders['x-request-id']).toBe('req-123');
    expect(firstHeaders['x-correlation-id']).toBe('corr-123');
    expect(firstHeaders['x-agroasys-timestamp']).toBeDefined();
    expect(firstHeaders['x-agroasys-signature']).toBeDefined();
    expect(firstHeaders['x-agroasys-nonce']).toBeDefined();
    expect(secondHeaders['x-agroasys-signature']).toBeDefined();
    expect(secondHeaders['x-agroasys-nonce']).toBeDefined();
    expect(secondHeaders['x-agroasys-nonce']).not.toBe(firstHeaders['x-agroasys-nonce']);
    expect(secondHeaders['x-agroasys-signature']).not.toBe(firstHeaders['x-agroasys-signature']);
  });

  test('applies legacy oracle auth contract without forwarding user bearer auth', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);
    global.fetch = fetchMock;

    const orchestrator = new ServiceOrchestrator(
      createDownstreamServiceRegistry([
        createContract({
          key: 'oracle',
          name: 'Oracle',
          source: 'oracle_http',
          baseUrl: 'https://oracle.example',
          healthPath: '/api/oracle/health',
          auth: {
            mode: 'oracle_legacy_hmac',
            headerStyle: 'legacy',
            apiKey: 'oracle-api-key',
            apiSecret: 'oracle-secret',
          },
        }),
      ]),
    );

    await orchestrator.fetch('oracle', {
      method: 'POST',
      path: '/api/oracle/release-stage1',
      body: { tradeId: 'TRD-77', requestId: 'req-77' },
      readOnly: false,
      authenticated: true,
      operation: 'oracle:releaseStage1',
      requestContext: { requestId: 'req-77', correlationId: 'corr-77' },
      headers: {
        Authorization: 'Bearer dashboard-session-should-not-pass-through',
      },
    });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer oracle-api-key');
    expect(headers['X-Timestamp']).toBeDefined();
    expect(headers['X-Signature']).toBeDefined();
    expect(headers['X-Nonce']).toBeDefined();
  });

  test('honors retry limits and fails closed for mutations', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: async () => '' } as Response);
    global.fetch = fetchMock;

    const orchestrator = new ServiceOrchestrator(
      createDownstreamServiceRegistry([createContract()]),
    );

    const response = await orchestrator.fetch('treasury', {
      method: 'POST',
      path: '/api/treasury/v1/ingest',
      body: { requestId: 'req-mutation' },
      readOnly: false,
      authenticated: true,
      operation: 'treasury:ingest',
      requestContext: { requestId: 'req-mutation', correlationId: 'corr-mutation' },
    });

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not force JSON content type for raw string or buffer payloads', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 202, text: async () => '' } as Response);
    global.fetch = fetchMock;

    const orchestrator = new ServiceOrchestrator(
      createDownstreamServiceRegistry([createContract()]),
    );

    await orchestrator.fetch('treasury', {
      method: 'POST',
      path: '/api/treasury/v1/upload',
      body: Buffer.from('signed-binary-payload', 'utf8'),
      readOnly: false,
      authenticated: true,
      operation: 'treasury:upload',
      headers: {
        'content-type': 'application/octet-stream',
      },
    });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/octet-stream');
  });

  test('times out reads with an explicit upstream-unavailable error', async () => {
    global.fetch = jest.fn().mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ ok: true, status: 200, text: async () => '' } as Response),
            100,
          );
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }),
    );

    const orchestrator = new ServiceOrchestrator(
      createDownstreamServiceRegistry([createContract({ readTimeoutMs: 25, readRetryBudget: 0 })]),
    );

    await expect(
      orchestrator.fetch('treasury', {
        method: 'GET',
        path: '/api/treasury/v1/entries',
        readOnly: true,
        authenticated: true,
        operation: 'treasury:listEntries',
      }),
    ).rejects.toMatchObject({
      statusCode: 504,
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});
