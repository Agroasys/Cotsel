import crypto from 'crypto';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { RicardianHashRow } from '../src/types';
import { DocumentNotFoundError } from '../src/errors';

const mockRows: RicardianHashRow[] = [];

jest.mock('../src/database/documentStore', () => ({
  createDocument: jest.fn(async (input: Record<string, unknown>) => {
    const row = {
      id: mockRows.length + 1,
      request_id: input.requestId,
      tenant_id: input.tenantId,
      document_ref: input.documentRef,
      hash: input.hash,
      rules_version: input.rulesVersion,
      canonical_json: input.canonicalJson,
      metadata: input.metadata,
      created_at: new Date('2026-09-30T00:00:00.000Z'),
    } as RicardianHashRow;
    mockRows.push(row);
    return row;
  }),
  getDocument: jest.fn(),
  getTenantDocument: jest.fn(async (hash: string, tenantId: string) => {
    const row = mockRows.find((item) => item.hash === hash && item.tenant_id === tenantId);
    if (!row) {
      throw new DocumentNotFoundError(hash);
    }
    return row;
  }),
}));

import { RicardianController } from '../src/api/controller';
import { createRouter } from '../src/api/routes';
import {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware,
  signServiceAuthCanonicalString,
} from '../src/auth/serviceAuth';
import { createDocument, getTenantDocument } from '../src/database/documentStore';

const GATEWAY = { id: 'cotsel-gateway', secret: 'gateway-secret', active: true };
const OTHER_SERVICE = { id: 'other-service', secret: 'other-secret', active: true };
const BASE_PATH = '/api/ricardian/v1';

function signedHeaders(
  principal: { id: string; secret: string },
  method: string,
  path: string,
  query: string,
  body: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const canonical = buildServiceAuthCanonicalString({
    method,
    path,
    query,
    bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
    timestamp,
    nonce,
  });

  return {
    'x-api-key': principal.id,
    'x-agroasys-timestamp': timestamp,
    'x-agroasys-nonce': nonce,
    'x-agroasys-signature': signServiceAuthCanonicalString(principal.secret, canonical),
  };
}

describe('ricardian tenant boundary across two authenticated principals', () => {
  let server: Server;
  let baseUrl: string;

  async function register(principal: typeof GATEWAY, body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    const response = await fetch(`${baseUrl}${BASE_PATH}/hash`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders(principal, 'POST', `${BASE_PATH}/hash`, '', raw),
      },
      body: raw,
    });
    return { status: response.status, payload: await response.json() };
  }

  async function fetchDocument(principal: typeof GATEWAY, hash: string, query: string) {
    const path = `${BASE_PATH}/hash/${hash}/document`;
    const response = await fetch(`${baseUrl}${path}${query ? `?${query}` : ''}`, {
      headers: signedHeaders(principal, 'GET', path, query, ''),
    });
    return { status: response.status, payload: await response.json() };
  }

  beforeEach(async () => {
    mockRows.length = 0;
    jest.clearAllMocks();
    const keys = new Map([GATEWAY, OTHER_SERVICE].map((key) => [key.id, key]));
    const consumed = new Set<string>();

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buffer) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
        },
      }),
    );
    app.use(
      BASE_PATH,
      createRouter(
        new RicardianController({
          authEnabled: true,
          delegationApiKeyIds: [GATEWAY.id],
        }),
        {
          authMiddleware: createServiceAuthMiddleware({
            enabled: true,
            maxSkewSeconds: 300,
            nonceTtlSeconds: 600,
            lookupApiKey: (apiKey) => keys.get(apiKey),
            consumeNonce: async (apiKey, nonce) => {
              const key = `${apiKey}:${nonce}`;
              if (consumed.has(key)) {
                return false;
              }
              consumed.add(key);
              return true;
            },
          }),
        },
      ),
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function registerPlatformDocument(): Promise<string> {
    const registered = await register(GATEWAY, {
      tenantId: 'platform-a',
      documentRef: 'doc://platform-a/trade-1',
      terms: { price: '1250.00' },
      metadata: { orderId: 'ORD-A-1' },
    });
    expect(registered.status).toBe(200);
    expect(registered.payload.data.tenantId).toBe('platform-a');
    return registered.payload.data.hash as string;
  }

  test('the delegating gateway registers and reads a platform tenant document', async () => {
    const hash = await registerPlatformDocument();

    const own = await fetchDocument(GATEWAY, hash, 'tenantId=platform-a');
    expect(own.status).toBe(200);
    expect(own.payload.data).toMatchObject({
      tenantId: 'platform-a',
      metadata: { orderId: 'ORD-A-1' },
    });

    const otherTenant = await fetchDocument(GATEWAY, hash, 'tenantId=platform-b');
    expect(otherTenant.status).toBe(404);
  });

  test('a non-delegated principal cannot name another tenant to read its document', async () => {
    const hash = await registerPlatformDocument();
    jest.mocked(getTenantDocument).mockClear();

    const response = await fetchDocument(OTHER_SERVICE, hash, 'tenantId=platform-a');

    expect(response.status).toBe(403);
    expect(response.payload.error).toBe('TenantMismatch');
    expect(JSON.stringify(response.payload)).not.toContain('ORD-A-1');
    expect(getTenantDocument).not.toHaveBeenCalled();
  });

  test('a non-delegated principal is scoped to itself when it names no tenant', async () => {
    const hash = await registerPlatformDocument();

    const response = await fetchDocument(OTHER_SERVICE, hash, '');

    expect(response.status).toBe(404);
    expect(getTenantDocument).toHaveBeenLastCalledWith(hash, OTHER_SERVICE.id);
    expect(JSON.stringify(response.payload)).not.toContain('ORD-A-1');
  });

  test('a non-delegated principal cannot register a document under another tenant', async () => {
    const response = await register(OTHER_SERVICE, {
      tenantId: 'platform-a',
      documentRef: 'doc://platform-a/forged',
      terms: { price: '1.00' },
    });

    expect(response.status).toBe(403);
    expect(response.payload.error).toBe('TenantMismatch');
    expect(createDocument).not.toHaveBeenCalled();
  });

  test('a non-delegated principal registers under its own principal by default', async () => {
    const response = await register(OTHER_SERVICE, {
      documentRef: 'doc://other/trade-1',
      terms: { price: '2.00' },
    });

    expect(response.status).toBe(200);
    expect(response.payload.data.tenantId).toBe(OTHER_SERVICE.id);
  });

  test('the tenant query is covered by the request signature', async () => {
    const hash = await registerPlatformDocument();
    const path = `${BASE_PATH}/hash/${hash}/document`;
    const headers = signedHeaders(OTHER_SERVICE, 'GET', path, `tenantId=${OTHER_SERVICE.id}`, '');

    const response = await fetch(`${baseUrl}${path}?tenantId=platform-a`, { headers });

    expect(response.status).toBe(401);
    expect(getTenantDocument).not.toHaveBeenCalledWith(hash, 'platform-a');
  });
});
