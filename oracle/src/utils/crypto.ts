import crypto from 'crypto';
import { Logger } from './logger';

const FINAL_RELEASE_OPERATIONS = new Set([
  'FINALIZE_AFTER_INSPECTION_ACCEPTANCE',
  'FINALIZE_TRADE',
]);

export function generateActionKey(operation: string, tradeId: string): string {
  const canonicalOperation = FINAL_RELEASE_OPERATIONS.has(operation) ? 'FINAL_RELEASE' : operation;
  return `${canonicalOperation}:${tradeId}`;
}

export function generateRequestId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function generateIdempotencyKey(actionKey: string): string {
  return `${actionKey}:${generateRequestId()}`;
}

export type RequestBodyBytes = string | Buffer;

export class RequestSignatureError extends Error {
  constructor(
    public readonly reason:
      | 'invalid_timestamp'
      | 'expired_timestamp'
      | 'future_timestamp'
      | 'invalid_signature',
  ) {
    super('Invalid request authentication');
    this.name = 'RequestSignatureError';
  }
}

export function generateRequestHash(
  timestamp: string,
  body: RequestBodyBytes,
  secret: string,
): string {
  return crypto.createHmac('sha256', secret).update(timestamp).update(body).digest('hex');
}

export function deriveRequestNonce(
  timestamp: string,
  body: RequestBodyBytes,
  signature: string,
): string {
  return crypto
    .createHash('sha256')
    .update(timestamp)
    .update(':')
    .update(body)
    .update(':')
    .update(signature)
    .digest('hex');
}

// Hash the HMAC signature so logs can correlate a request without exposing any
// portion of the raw signature material.
export function hashSignature(signature: string): string {
  return crypto.createHash('sha256').update(signature).digest('hex');
}

export function hashNonce(nonce: string): string {
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

export function verifyRequestSignature(
  timestamp: string,
  body: RequestBodyBytes,
  signature: string,
  secret: string,
  maxAgeMinutes: number = 5,
): boolean {
  if (!/^\d{13}$/.test(timestamp)) {
    throw new RequestSignatureError('invalid_timestamp');
  }

  const requestTimeMs = Number(timestamp);
  if (!Number.isSafeInteger(requestTimeMs)) {
    throw new RequestSignatureError('invalid_timestamp');
  }

  const ageMinutes = (Date.now() - requestTimeMs) / (1000 * 60);

  if (ageMinutes > maxAgeMinutes) {
    throw new RequestSignatureError('expired_timestamp');
  }

  if (ageMinutes < -1) {
    throw new RequestSignatureError('future_timestamp');
  }

  const expectedHash = generateRequestHash(timestamp, body, secret);

  if (!/^[0-9a-fA-F]{64}$/.test(signature)) {
    throw new RequestSignatureError('invalid_signature');
  }

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedHash, 'hex'),
  );

  if (!isValid) {
    throw new RequestSignatureError('invalid_signature');
  }

  Logger.info('Request signature verified', {
    timestamp,
    ageSeconds: (ageMinutes * 60).toFixed(1),
  });

  return true;
}

export function generateJitter(maxJitterMs: number = 1000): number {
  if (maxJitterMs <= 0) {
    return 0;
  }

  return Math.floor(Math.random() * maxJitterMs);
}

export function calculateBackoff(
  attempt: number,
  baseDelay: number,
  maxDelayMs: number = 30000,
  maxJitterMs: number = 1000,
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const cappedExponentialDelay = Math.min(exponentialDelay, maxDelayMs);
  const availableJitterWindow = Math.max(0, maxDelayMs - cappedExponentialDelay);
  const jitter = generateJitter(Math.min(maxJitterMs, availableJitterWindow + 1));
  const totalDelay = cappedExponentialDelay + jitter;

  Logger.info('Calculated backoff', {
    attempt,
    exponentialDelay,
    cappedExponentialDelay,
    maxDelayMs,
    jitter,
    totalDelay,
  });

  return totalDelay;
}
