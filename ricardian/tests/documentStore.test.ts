const mockDbCreateHash = jest.fn();
const mockDbGetHash = jest.fn();

jest.mock('../src/database/queries', () => ({
  createRicardianHash: mockDbCreateHash,
  getRicardianHash: mockDbGetHash,
}));

jest.mock('../src/utils/logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../src/metrics/counters', () => ({
  incrementDocumentStoreRetry: jest.fn(),
  incrementDocumentStoreFailure: jest.fn(),
  incrementDocumentIntegrityFailure: jest.fn(),
  incrementAuthFailure: jest.fn(),
  incrementReplayReject: jest.fn(),
}));

import { createDocument, getDocument } from '../src/database/documentStore';
import {
  DocumentIntegrityError,
  DocumentNotFoundError,
  DocumentPersistenceError,
  DocumentRetrievalError,
} from '../src/errors';
import { buildRicardianHash } from '../src/utils/hash';

function makeValidRow() {
  const result = buildRicardianHash({
    documentRef: 'doc://test-trade-001',
    terms: { currency: 'USDC', quantityMt: 50 },
    metadata: { tradeId: '1' },
  });

  return {
    id: 1,
    request_id: 'req-abc',
    document_ref: result.documentRef,
    hash: result.hash,
    rules_version: result.rulesVersion,
    canonical_json: result.canonicalJson,
    metadata: result.metadata,
    created_at: new Date(),
  };
}

function makeTransientPgError(message = 'connection terminated unexpectedly'): Error {
  return new Error(message);
}

function makeTransientPgCodeError(code: string): Error & { code: string } {
  const err = new Error('pg error') as Error & { code: string };
  err.code = code;
  return err;
}

describe('documentStore.createDocument', () => {
  const validInput = {
    requestId: 'req-1',
    documentRef: 'doc://trade-1',
    hash: 'a'.repeat(64),
    rulesVersion: 'RICARDIAN_CANONICAL_V1',
    canonicalJson: '{"documentRef":"doc://trade-1"}',
    metadata: {},
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('returns row on success', async () => {
    const row = makeValidRow();
    mockDbCreateHash.mockResolvedValueOnce(row);

    const result = await createDocument(validInput);

    expect(result).toBe(row);
    expect(mockDbCreateHash).toHaveBeenCalledTimes(1);
  });

  test('retries on transient connection error then succeeds', async () => {
    const row = makeValidRow();
    mockDbCreateHash
      .mockRejectedValueOnce(makeTransientPgError('connection terminated'))
      .mockResolvedValueOnce(row);

    const result = await createDocument(validInput);

    expect(result).toBe(row);
    expect(mockDbCreateHash).toHaveBeenCalledTimes(2);
  });

  test('retries on transient pg error code (40001) then succeeds', async () => {
    const row = makeValidRow();
    mockDbCreateHash
      .mockRejectedValueOnce(makeTransientPgCodeError('40001'))
      .mockRejectedValueOnce(makeTransientPgCodeError('40001'))
      .mockResolvedValueOnce(row);

    const result = await createDocument(validInput);

    expect(result).toBe(row);
    expect(mockDbCreateHash).toHaveBeenCalledTimes(3);
  });

  test('throws DocumentPersistenceError after exhausting all retries', async () => {
    mockDbCreateHash.mockRejectedValue(makeTransientPgError('connection reset'));

    await expect(createDocument(validInput)).rejects.toBeInstanceOf(DocumentPersistenceError);
    expect(mockDbCreateHash).toHaveBeenCalledTimes(4);
  });

  test('throws DocumentPersistenceError immediately on non-transient error', async () => {
    mockDbCreateHash.mockRejectedValueOnce(new Error('unique constraint violated'));

    await expect(createDocument(validInput)).rejects.toBeInstanceOf(DocumentPersistenceError);
    expect(mockDbCreateHash).toHaveBeenCalledTimes(1);
  });

  test('thrown DocumentPersistenceError carries stable code', async () => {
    mockDbCreateHash.mockRejectedValueOnce(new Error('disk full'));

    await expect(createDocument(validInput)).rejects.toMatchObject({
      code: 'DOCUMENT_PERSISTENCE_FAILURE',
    });
  });
});

describe('documentStore.getDocument', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('returns integrity-verified row on success', async () => {
    const row = makeValidRow();
    mockDbGetHash.mockResolvedValueOnce(row);

    const result = await getDocument(row.hash);

    expect(result).toBe(row);
    expect(mockDbGetHash).toHaveBeenCalledWith(row.hash);
  });

  test('throws DocumentNotFoundError when DB returns null', async () => {
    mockDbGetHash.mockResolvedValueOnce(null);

    await expect(getDocument('a'.repeat(64))).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  test('DocumentNotFoundError carries stable code and hash', async () => {
    const hash = 'b'.repeat(64);
    mockDbGetHash.mockResolvedValueOnce(null);

    await expect(getDocument(hash)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
      hash,
    });
  });

  test('throws DocumentIntegrityError when stored hash does not match recomputed hash', async () => {
    const row = { ...makeValidRow(), hash: 'deadbeef'.repeat(8) }; // tampered hash
    mockDbGetHash.mockResolvedValueOnce(row);

    await expect(getDocument(row.hash)).rejects.toBeInstanceOf(DocumentIntegrityError);
  });

  test('DocumentIntegrityError carries stable code', async () => {
    const row = { ...makeValidRow(), hash: '0'.repeat(64) }; // wrong hash
    mockDbGetHash.mockResolvedValueOnce(row);

    await expect(getDocument(row.hash)).rejects.toMatchObject({
      code: 'DOCUMENT_INTEGRITY_FAILURE',
    });
  });

  test('retries on transient timeout error then succeeds', async () => {
    const row = makeValidRow();
    mockDbGetHash
      .mockRejectedValueOnce(makeTransientPgError('timeout acquiring client'))
      .mockResolvedValueOnce(row);

    const result = await getDocument(row.hash);

    expect(result).toBe(row);
    expect(mockDbGetHash).toHaveBeenCalledTimes(2);
  });

  test('throws DocumentRetrievalError after exhausting all retries', async () => {
    mockDbGetHash.mockRejectedValue(makeTransientPgError('econnrefused'));

    await expect(getDocument('c'.repeat(64))).rejects.toBeInstanceOf(DocumentRetrievalError);
    expect(mockDbGetHash).toHaveBeenCalledTimes(4);
  });

  test('throws DocumentRetrievalError immediately on non-transient error', async () => {
    mockDbGetHash.mockRejectedValueOnce(new Error('syntax error in sql'));

    await expect(getDocument('d'.repeat(64))).rejects.toBeInstanceOf(DocumentRetrievalError);
    expect(mockDbGetHash).toHaveBeenCalledTimes(1);
  });

  test('thrown DocumentRetrievalError carries stable code', async () => {
    mockDbGetHash.mockRejectedValueOnce(new Error('read failure'));

    await expect(getDocument('e'.repeat(64))).rejects.toMatchObject({
      code: 'DOCUMENT_RETRIEVAL_FAILURE',
    });
  });
});
