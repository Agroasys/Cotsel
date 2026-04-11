import { createRicardianHash as dbCreateHash, getRicardianHash as dbGetHash } from './queries';
import { RicardianHashRow } from '../types';
import {
  DocumentIntegrityError,
  DocumentNotFoundError,
  DocumentPersistenceError,
  DocumentRetrievalError,
} from '../errors';
import { Logger } from '../utils/logger';
import { verifyHashIntegrity } from '../utils/hash';
import {
  incrementDocumentIntegrityFailure,
  incrementDocumentStoreFailure,
  incrementDocumentStoreRetry,
} from '../metrics/counters';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

// PostgreSQL error codes considered transient:
//   40001 — serialization_failure
//   40P01 — deadlock_detected
//   08006 — connection_failure
//   08001 — sqlclient_unable_to_establish_sqlconnection
//   08004 — sqlserver_rejected_establishment_of_sqlconnection
//   57P03 — cannot_connect_now
//   53300 — too_many_connections
const TRANSIENT_PG_CODES = new Set(['40001', '40P01', '08006', '08001', '08004', '57P03', '53300']);

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const pgCode = (error as NodeJS.ErrnoException & { code?: string }).code;
  if (pgCode && TRANSIENT_PG_CODES.has(pgCode)) return true;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('connection') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('serialization failure')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientError(error) || attempt === MAX_RETRIES) {
        break;
      }

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      incrementDocumentStoreRetry(operationName);
      Logger.warn('DocumentStore transient error, retrying', {
        operationName,
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
        delayMs,
        error: (error as Error)?.message,
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}

export interface DocumentCreateInput {
  requestId: string;
  documentRef: string;
  hash: string;
  rulesVersion: string;
  canonicalJson: string;
  metadata: Record<string, unknown>;
}

export async function createDocument(data: DocumentCreateInput): Promise<RicardianHashRow> {
  try {
    return await withRetry(() => dbCreateHash(data), 'createDocument');
  } catch (error) {
    incrementDocumentStoreFailure('createDocument', 'DOCUMENT_PERSISTENCE_FAILURE');
    Logger.error('DocumentStore createDocument failed', {
      documentRef: data.documentRef,
      hash: data.hash,
      error: (error as Error)?.message,
    });
    throw new DocumentPersistenceError(
      `Failed to persist Ricardian hash for documentRef: ${data.documentRef}`,
      error,
    );
  }
}

export async function getDocument(hash: string): Promise<RicardianHashRow> {
  let row: RicardianHashRow | null;

  try {
    row = await withRetry(() => dbGetHash(hash), 'getDocument');
  } catch (error) {
    incrementDocumentStoreFailure('getDocument', 'DOCUMENT_RETRIEVAL_FAILURE');
    Logger.error('DocumentStore getDocument failed', {
      hash,
      error: (error as Error)?.message,
    });
    throw new DocumentRetrievalError(`Failed to retrieve Ricardian hash: ${hash}`, error);
  }

  if (!row) {
    throw new DocumentNotFoundError(hash);
  }

  if (
    !verifyHashIntegrity({
      hash: row.hash,
      rulesVersion: row.rules_version,
      canonicalJson: row.canonical_json,
    })
  ) {
    incrementDocumentIntegrityFailure();
    Logger.error('DocumentStore integrity violation detected', {
      hash,
      storedHash: row.hash,
      rulesVersion: row.rules_version,
    });
    throw new DocumentIntegrityError(hash);
  }

  return row;
}
