import type { Request, Response } from 'express';
import { RicardianController } from '../src/api/controller';
import type { RicardianRegistrationRequest } from '../src/types';
import { buildRicardianHash } from '../src/utils/hash';
import { createDocument, getDocument, getTenantDocument } from '../src/database/documentStore';
import {
  DocumentConflictError,
  DocumentIntegrityError,
  DocumentNotFoundError,
  DocumentPersistenceError,
  DocumentRetrievalError,
} from '../src/errors';

jest.mock('../src/utils/hash', () => ({
  buildRicardianHash: jest.fn(),
}));

jest.mock('../src/database/documentStore', () => ({
  createDocument: jest.fn(),
  getDocument: jest.fn(),
  getTenantDocument: jest.fn(),
}));

type MockedResponse = Response & {
  status: jest.Mock;
  json: jest.Mock;
};

function asHashRequest(
  body: unknown,
): Request<Record<string, never>, Record<string, never>, RicardianRegistrationRequest> {
  return { body } as unknown as Request<
    Record<string, never>,
    Record<string, never>,
    RicardianRegistrationRequest
  >;
}

function createMockResponse(): MockedResponse {
  const res = {} as MockedResponse;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('RicardianController.createHash', () => {
  const controller = new RicardianController();
  const mockedBuildRicardianHash = buildRicardianHash as jest.MockedFunction<
    typeof buildRicardianHash
  >;
  const mockedCreateDocument = createDocument as jest.MockedFunction<typeof createDocument>;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('returns 400 for payload validation failures', async () => {
    mockedBuildRicardianHash.mockImplementation(() => {
      throw new Error('documentRef is required');
    });

    const req = asHashRequest({ tenantId: 'platform-main' });
    const res = createMockResponse();

    await controller.createHash(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'ValidationError',
        message: 'documentRef is required',
      }),
    );
  });

  test('returns 500 with stable code for DocumentPersistenceError', async () => {
    mockedBuildRicardianHash.mockReturnValue({
      requestId: 'req-1',
      documentRef: 'doc://ok',
      canonicalJson: '{"ok":true}',
      hash: 'a'.repeat(64),
      rulesVersion: 'RICARDIAN_CANONICAL_V1',
      metadata: {},
    });

    mockedCreateDocument.mockRejectedValue(new DocumentPersistenceError('db unavailable'));

    const req = asHashRequest({
      tenantId: 'platform-main',
      documentRef: 'doc://ok',
      terms: { ok: true },
    });
    const res = createMockResponse();

    await controller.createHash(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'DOCUMENT_PERSISTENCE_FAILURE',
      }),
    );
  });

  test('returns 409 when a registration conflicts with immutable history', async () => {
    mockedBuildRicardianHash.mockReturnValue({
      requestId: 'req-1',
      documentRef: 'doc://trade-1',
      canonicalJson: '{"ok":true}',
      hash: 'a'.repeat(64),
      rulesVersion: 'RICARDIAN_CANONICAL_V1',
      metadata: {},
    });
    mockedCreateDocument.mockRejectedValue(
      new DocumentConflictError('a'.repeat(64), 'doc://trade-1'),
    );

    const req = asHashRequest({
      tenantId: 'platform-main',
      documentRef: 'doc://trade-1',
      terms: { ok: true },
    });
    const res = createMockResponse();

    await controller.createHash(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'DOCUMENT_REGISTRATION_CONFLICT',
      }),
    );
  });

  test('returns 500 without code for generic persistence error', async () => {
    mockedBuildRicardianHash.mockReturnValue({
      requestId: 'req-1',
      documentRef: 'doc://ok',
      canonicalJson: '{"ok":true}',
      hash: 'a'.repeat(64),
      rulesVersion: 'RICARDIAN_CANONICAL_V1',
      metadata: {},
    });

    mockedCreateDocument.mockRejectedValue(new Error('unexpected db error'));

    const req = asHashRequest({
      tenantId: 'platform-main',
      documentRef: 'doc://ok',
      terms: { ok: true },
    });
    const res = createMockResponse();

    await controller.createHash(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'InternalError',
        message: 'unexpected db error',
      }),
    );
  });
});

describe('RicardianController.getHash', () => {
  const controller = new RicardianController();
  const mockedGetDocument = getDocument as jest.MockedFunction<typeof getDocument>;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('returns 400 for invalid hash format', async () => {
    const req = { params: { hash: 'not-a-hash' } } as unknown as Request<{ hash: string }>;
    const res = createMockResponse();

    await controller.getHash(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'ValidationError',
        message: 'Invalid hash format',
      }),
    );
  });

  test('returns 200 with row on success', async () => {
    const row = {
      id: 1,
      request_id: 'req-1',
      tenant_id: 'platform-main',
      document_ref: 'doc://trade-1',
      hash: 'a'.repeat(64),
      rules_version: 'RICARDIAN_CANONICAL_V1',
      canonical_json: '{}',
      metadata: {},
      created_at: new Date('2026-03-11T00:00:00Z'),
    };
    mockedGetDocument.mockResolvedValueOnce(row);

    const req = { params: { hash: 'a'.repeat(64) } } as unknown as Request<{ hash: string }>;
    const res = createMockResponse();

    await controller.getHash(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Generic lookup is a minimal attestation: no terms, metadata, reference, or tenant.
    expect(res.json.mock.calls[0][0].data).toEqual({
      hash: 'a'.repeat(64),
      rulesVersion: 'RICARDIAN_CANONICAL_V1',
      registeredAt: '2026-03-11T00:00:00.000Z',
    });
  });

  test('returns 404 with stable code for DocumentNotFoundError', async () => {
    const hash = 'b'.repeat(64);
    mockedGetDocument.mockRejectedValueOnce(new DocumentNotFoundError(hash));

    const req = { params: { hash } } as unknown as Request<{ hash: string }>;
    const res = createMockResponse();

    await controller.getHash(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'DOCUMENT_NOT_FOUND' }),
    );
  });

  test('returns 500 with DOCUMENT_RETRIEVAL_FAILURE code for DocumentRetrievalError', async () => {
    const hash = 'c'.repeat(64);
    mockedGetDocument.mockRejectedValueOnce(new DocumentRetrievalError('db down'));

    const req = { params: { hash } } as unknown as Request<{ hash: string }>;
    const res = createMockResponse();

    await controller.getHash(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'DOCUMENT_RETRIEVAL_FAILURE' }),
    );
  });

  test('returns 500 with DOCUMENT_INTEGRITY_FAILURE code for DocumentIntegrityError', async () => {
    const hash = 'd'.repeat(64);
    mockedGetDocument.mockRejectedValueOnce(new DocumentIntegrityError(hash));

    const req = { params: { hash } } as unknown as Request<{ hash: string }>;
    const res = createMockResponse();

    await controller.getHash(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'DOCUMENT_INTEGRITY_FAILURE' }),
    );
  });
});

describe('RicardianController tenant boundary', () => {
  const controller = new RicardianController();
  const mockedBuildRicardianHash = buildRicardianHash as jest.MockedFunction<
    typeof buildRicardianHash
  >;
  const mockedCreateDocument = createDocument as jest.MockedFunction<typeof createDocument>;
  const mockedGetTenantDocument = getTenantDocument as jest.MockedFunction<
    typeof getTenantDocument
  >;
  const hash = 'a'.repeat(64);
  const row = {
    id: 1,
    request_id: 'req-1',
    tenant_id: 'platform-main',
    document_ref: 'doc://trade-1',
    hash,
    rules_version: 'RICARDIAN_CANONICAL_V1',
    canonical_json: '{"terms":{"price":"1"}}',
    metadata: { orderId: 'ORD-1' },
    created_at: new Date('2026-03-11T00:00:00Z'),
  };

  function tenantDocumentRequest(tenantId: unknown): Request<{ hash: string }> {
    return { params: { hash }, query: { tenantId } } as unknown as Request<{ hash: string }>;
  }

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test.each([
    ['missing', undefined],
    ['blank', '  '],
    ['malformed', 'platform main'],
    ['oversized', `t${'x'.repeat(128)}`],
    ['repeated', ['platform-main', 'platform-other']],
  ])('rejects registration with a %s tenantId before hashing', async (_label, tenantId) => {
    const res = createMockResponse();

    await controller.createHash(
      asHashRequest({ tenantId, documentRef: 'doc://ok', terms: { ok: true } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedBuildRicardianHash).not.toHaveBeenCalled();
    expect(mockedCreateDocument).not.toHaveBeenCalled();
  });

  test('binds the registration to the tenant and returns it', async () => {
    mockedBuildRicardianHash.mockReturnValue({
      requestId: 'req-1',
      documentRef: 'doc://trade-1',
      canonicalJson: row.canonical_json,
      hash,
      rulesVersion: 'RICARDIAN_CANONICAL_V1',
      metadata: row.metadata,
    });
    mockedCreateDocument.mockResolvedValueOnce(row);
    const res = createMockResponse();

    await controller.createHash(
      asHashRequest({
        tenantId: 'platform-main',
        documentRef: 'doc://trade-1',
        terms: { price: '1' },
      }),
      res,
    );

    expect(mockedCreateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'platform-main' }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'platform-main', documentRef: 'doc://trade-1' }),
      }),
    );
  });

  test('returns complete terms and metadata to the owning tenant', async () => {
    mockedGetTenantDocument.mockResolvedValueOnce(row);
    const res = createMockResponse();

    await controller.getTenantDocument(tenantDocumentRequest('platform-main'), res);

    expect(mockedGetTenantDocument).toHaveBeenCalledWith(hash, 'platform-main');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'platform-main',
          canonicalJson: row.canonical_json,
          metadata: row.metadata,
        }),
      }),
    );
  });

  test('answers a cross-tenant request exactly like an unknown hash', async () => {
    mockedGetTenantDocument.mockRejectedValueOnce(new DocumentNotFoundError(hash));
    const res = createMockResponse();

    await controller.getTenantDocument(tenantDocumentRequest('platform-other'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'DOCUMENT_NOT_FOUND' }),
    );
    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).not.toContain('platform-main');
    expect(body).not.toContain('ORD-1');
  });

  test.each([
    ['missing', undefined],
    ['malformed', 'platform/main'],
    ['repeated', ['platform-main', 'platform-main']],
  ])('rejects full retrieval with a %s tenantId', async (_label, tenantId) => {
    const res = createMockResponse();

    await controller.getTenantDocument(tenantDocumentRequest(tenantId), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedGetTenantDocument).not.toHaveBeenCalled();
  });
});
