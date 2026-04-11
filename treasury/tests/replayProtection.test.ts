import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware,
  signServiceAuthCanonicalString,
} from '../src/auth/serviceAuth';

interface MockResponse extends Response {
  status: jest.Mock;
  json: jest.Mock;
}

function createMockResponse(): MockResponse {
  const response = {} as MockResponse;
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

function createSignedRequest(options?: {
  method?: string;
  path?: string;
  query?: string;
  body?: Buffer;
  apiKey?: string;
  timestamp?: string;
  nonce?: string;
  secret?: string;
  signatureOverride?: string;
}) {
  const method = options?.method || 'POST';
  const path = options?.path || '/api/treasury/v1/ingest';
  const query = options?.query || '';
  const body = options?.body || Buffer.from('{"ingest":true}');
  const timestamp = options?.timestamp || '1700000000';
  const nonce = options?.nonce || 'nonce-1';
  const apiKey = options?.apiKey || 'svc-a';
  const secret = options?.secret || 'secret-a';

  const bodySha256 = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = buildServiceAuthCanonicalString({
    method,
    path,
    query,
    bodySha256,
    timestamp,
    nonce,
  });

  const signature = options?.signatureOverride || signServiceAuthCanonicalString(secret, canonical);
  const originalUrl = query ? `${path}?${query}` : path;

  const headers = new Map<string, string>([
    ['x-api-key', apiKey],
    ['x-timestamp', timestamp],
    ['x-nonce', nonce],
    ['x-signature', signature],
  ]);

  const request = {
    method,
    originalUrl,
    rawBody: body,
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
  } as unknown as Request;

  return { request, headers };
}

function createAtomicNonceConsumer(nowSeconds: () => number) {
  const consumed = new Map<string, number>();

  return async (apiKey: string, nonce: string, ttlSeconds: number): Promise<boolean> => {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('ttl must be positive');
    }

    const key = `${apiKey}:${nonce}`;
    const expiresAt = consumed.get(key);
    const now = nowSeconds();

    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }

    consumed.set(key, now + ttlSeconds);
    return true;
  };
}

describe('treasury replay protection', () => {
  const lookupApiKey = (apiKey: string) => {
    if (apiKey === 'svc-a') {
      return { id: 'svc-a', secret: 'secret-a', active: true };
    }

    if (apiKey === 'svc-b') {
      return { id: 'svc-b', secret: 'secret-b', active: true };
    }

    return undefined;
  };

  let now = 1700000000;
  const nowSeconds = () => now;

  test('sequential duplicate nonce is rejected after first consume', async () => {
    const consumeNonce = createAtomicNonceConsumer(nowSeconds);
    const middleware = createServiceAuthMiddleware({
      enabled: true,
      maxSkewSeconds: 300,
      nonceTtlSeconds: 30,
      lookupApiKey,
      consumeNonce,
      nowSeconds,
    });

    const firstResponse = createMockResponse();
    const firstNext = jest.fn() as NextFunction;
    await middleware(createSignedRequest({ nonce: 'dup-nonce' }).request, firstResponse, firstNext);

    const secondResponse = createMockResponse();
    const secondNext = jest.fn() as NextFunction;
    await middleware(
      createSignedRequest({ nonce: 'dup-nonce' }).request,
      secondResponse,
      secondNext,
    );

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.status).toHaveBeenCalledWith(401);
  });

  test('parallel duplicate nonce allows exactly one success', async () => {
    const consumeNonce = createAtomicNonceConsumer(nowSeconds);
    const middleware = createServiceAuthMiddleware({
      enabled: true,
      maxSkewSeconds: 300,
      nonceTtlSeconds: 120,
      lookupApiKey,
      consumeNonce,
      nowSeconds,
    });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const response = createMockResponse();
        const next = jest.fn();
        await middleware(
          createSignedRequest({ nonce: 'parallel-nonce' }).request,
          response,
          next as unknown as NextFunction,
        );

        return {
          accepted: next.mock.calls.length === 1,
          status: response.status.mock.calls[0]?.[0],
        };
      }),
    );

    const acceptedCount = outcomes.filter((entry) => entry.accepted).length;
    const replayRejectedCount = outcomes.filter(
      (entry) => !entry.accepted && entry.status === 401,
    ).length;

    expect(acceptedCount).toBe(1);
    expect(replayRejectedCount).toBe(9);
  });

  test('ttl boundary blocks before expiry and allows at boundary', async () => {
    const consumeNonce = createAtomicNonceConsumer(nowSeconds);
    const middleware = createServiceAuthMiddleware({
      enabled: true,
      maxSkewSeconds: 300,
      nonceTtlSeconds: 10,
      lookupApiKey,
      consumeNonce,
      nowSeconds,
    });

    const nonce = 'ttl-boundary';

    const firstResponse = createMockResponse();
    const firstNext = jest.fn() as NextFunction;
    await middleware(createSignedRequest({ nonce }).request, firstResponse, firstNext);

    now = 1700000009;
    const beforeExpiryResponse = createMockResponse();
    const beforeExpiryNext = jest.fn() as NextFunction;
    await middleware(
      createSignedRequest({ nonce, timestamp: '1700000009' }).request,
      beforeExpiryResponse,
      beforeExpiryNext,
    );

    now = 1700000010;
    const atExpiryResponse = createMockResponse();
    const atExpiryNext = jest.fn() as NextFunction;
    await middleware(
      createSignedRequest({ nonce, timestamp: '1700000010' }).request,
      atExpiryResponse,
      atExpiryNext,
    );

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(beforeExpiryNext).not.toHaveBeenCalled();
    expect(beforeExpiryResponse.status).toHaveBeenCalledWith(401);
    expect(atExpiryNext).toHaveBeenCalledTimes(1);
  });

  test('nonce uniqueness is scoped per api key', async () => {
    const consumeNonce = createAtomicNonceConsumer(nowSeconds);
    const middleware = createServiceAuthMiddleware({
      enabled: true,
      maxSkewSeconds: 300,
      nonceTtlSeconds: 60,
      lookupApiKey,
      consumeNonce,
      nowSeconds,
    });

    const nonce = 'shared-nonce';

    const responseA = createMockResponse();
    const nextA = jest.fn() as NextFunction;
    await middleware(
      createSignedRequest({ apiKey: 'svc-a', secret: 'secret-a', nonce }).request,
      responseA,
      nextA,
    );

    const responseB = createMockResponse();
    const nextB = jest.fn() as NextFunction;
    await middleware(
      createSignedRequest({ apiKey: 'svc-b', secret: 'secret-b', nonce }).request,
      responseB,
      nextB,
    );

    expect(nextA).toHaveBeenCalledTimes(1);
    expect(nextB).toHaveBeenCalledTimes(1);
  });

  test('consume nonce error fails closed', async () => {
    const middleware = createServiceAuthMiddleware({
      enabled: true,
      maxSkewSeconds: 300,
      nonceTtlSeconds: 60,
      lookupApiKey,
      consumeNonce: jest.fn().mockRejectedValue(new Error('db unavailable')),
      nowSeconds,
    });

    const response = createMockResponse();
    const next = jest.fn();

    await middleware(
      createSignedRequest({ nonce: 'db-error' }).request,
      response,
      next as unknown as NextFunction,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
