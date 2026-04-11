/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'crypto';

export interface ServiceAuthHeaders {
  'X-Api-Key': string;
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Signature': string;
}

export interface ServiceAuthSignInput {
  apiKey: string;
  apiSecret: string;
  method: string;
  path: string;
  query?: string;
  body?: string | Buffer | Record<string, unknown> | null;
  timestamp?: number;
  nonce?: string;
}

function normalizeQuery(query: string | undefined): string {
  if (!query) {
    return '';
  }

  return query.startsWith('?') ? query.slice(1) : query;
}

function bodyToBuffer(body: ServiceAuthSignInput['body']): Buffer {
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === 'string') {
    return Buffer.from(body);
  }

  return Buffer.from(JSON.stringify(body));
}

export function buildServiceAuthCanonicalString(parts: {
  method: string;
  path: string;
  query: string;
  bodySha256: string;
  timestamp: string;
  nonce: string;
}): string {
  return [
    parts.method,
    parts.path,
    parts.query,
    parts.bodySha256,
    parts.timestamp,
    parts.nonce,
  ].join('\n');
}

export function signServiceAuthCanonicalString(secret: string, canonicalString: string): string {
  return crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
}

export function createServiceAuthHeaders(input: ServiceAuthSignInput): ServiceAuthHeaders {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce || crypto.randomBytes(16).toString('hex');
  const query = normalizeQuery(input.query);
  const bodySha256 = crypto.createHash('sha256').update(bodyToBuffer(input.body)).digest('hex');

  const canonicalString = buildServiceAuthCanonicalString({
    method: input.method.toUpperCase(),
    path: input.path,
    query,
    bodySha256,
    timestamp,
    nonce,
  });

  return {
    'X-Api-Key': input.apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signServiceAuthCanonicalString(input.apiSecret, canonicalString),
  };
}
