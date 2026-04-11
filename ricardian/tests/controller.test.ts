import type { Request, Response } from 'express';
import { RicardianController } from '../src/api/controller';
import type { RicardianHashRequest } from '../src/types';
import { buildRicardianHash } from '../src/utils/hash';
import { createDocument, getDocument } from '../src/database/documentStore';
import {
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
}));

type MockedResponse = Response & {
  status: jest.Mock;
  json: jest.Mock;
};

function asHashRequest(
  body: unknown,
): Request<Record<string, never>, Record<string, never>, RicardianHashRequest> {
  return { body } as unknown as Request<
    Record<string, never>,
    Record<string, never>,
    RicardianHashRequest
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

    const req = asHashRequest({});
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

    const req = asHashRequest({ documentRef: 'doc://ok', terms: { ok: true } });
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

    const req = asHashRequest({ documentRef: 'doc://ok', terms: { ok: true } });
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
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
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
