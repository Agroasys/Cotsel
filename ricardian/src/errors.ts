/**
 * Typed error hierarchy for DocumentStore operations.
 *
 * All errors carry a stable machine-readable `code` for deterministic
 * HTTP mapping, logging, and operator escalation.
 */

export class DocumentStoreError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = 'DocumentStoreError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Hash looked up but not present in the document store.
 * Maps to HTTP 404.
 */
export class DocumentNotFoundError extends DocumentStoreError {
  readonly hash: string;

  constructor(hash: string) {
    super(`Ricardian hash not found: ${hash}`, 'DOCUMENT_NOT_FOUND');
    this.name = 'DocumentNotFoundError';
    this.hash = hash;
  }
}

/**
 * Write operation failed after exhausting retries.
 * Maps to HTTP 500.
 */
export class DocumentPersistenceError extends DocumentStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DOCUMENT_PERSISTENCE_FAILURE', cause);
    this.name = 'DocumentPersistenceError';
  }
}

/**
 * A registration retried an existing hash/document pair with different canonical content.
 * The historical row is never mutated. Maps to HTTP 409.
 */
export class DocumentConflictError extends DocumentStoreError {
  constructor(hash: string, documentRef: string) {
    super(
      `Ricardian registration conflicts with immutable history for ${documentRef} (${hash})`,
      'DOCUMENT_REGISTRATION_CONFLICT',
    );
    this.name = 'DocumentConflictError';
  }
}

/**
 * Read operation failed after exhausting retries.
 * Maps to HTTP 500.
 */
export class DocumentRetrievalError extends DocumentStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DOCUMENT_RETRIEVAL_FAILURE', cause);
    this.name = 'DocumentRetrievalError';
  }
}

/**
 * Retrieved row failed SHA-256 integrity check: stored hash does not match
 * recomputed hash over stored canonical_json + rules_version.
 * Indicates storage-layer tampering or corruption. Maps to HTTP 500.
 * Requires immediate operator escalation.
 */
export class DocumentIntegrityError extends DocumentStoreError {
  readonly hash: string;

  constructor(hash: string, cause?: unknown) {
    super(`Ricardian hash integrity check failed: ${hash}`, 'DOCUMENT_INTEGRITY_FAILURE', cause);
    this.name = 'DocumentIntegrityError';
    this.hash = hash;
  }
}
