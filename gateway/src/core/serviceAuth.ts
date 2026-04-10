/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware as createSharedServiceAuthMiddleware,
  parseServiceApiKeys,
  signServiceAuthCanonicalString,
  type ServiceApiKey,
  type ServiceAuthMiddlewareOptions,
} from '@agroasys/shared-auth/serviceAuth';
import crypto from 'crypto';

export {
  parseServiceApiKeys,
  type ServiceApiKey,
  type ServiceAuthContext,
  type ServiceAuthMiddlewareOptions,
} from '@agroasys/shared-auth/serviceAuth';

export interface ServiceAuthHeaders {
  'X-Api-Key': string;
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Signature': string;
}

export function createServiceAuthHeaders(input: {
  apiKey: string;
  apiSecret: string;
  method: string;
  path: string;
  query?: string;
  body?: string | Buffer | Record<string, unknown> | null;
  timestamp?: number;
  nonce?: string;
}): ServiceAuthHeaders {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce || crypto.randomBytes(16).toString('hex');
  const query = input.query ? input.query.replace(/^\?/, '') : '';
  const bodyBuffer =
    input.body === undefined || input.body === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(input.body)
        ? input.body
        : typeof input.body === 'string'
          ? Buffer.from(input.body)
          : Buffer.from(JSON.stringify(input.body));

  const canonical = buildServiceAuthCanonicalString({
    method: input.method.toUpperCase(),
    path: input.path,
    query,
    bodySha256: crypto.createHash('sha256').update(bodyBuffer).digest('hex'),
    timestamp,
    nonce,
  });

  return {
    'X-Api-Key': input.apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signServiceAuthCanonicalString(input.apiSecret, canonical),
  };
}

export function createServiceAuthMiddleware(options: ServiceAuthMiddlewareOptions) {
  return createSharedServiceAuthMiddleware(options);
}

export function createServiceApiKeyLookup(
  rawKeys: string,
): (apiKey: string) => ServiceApiKey | undefined {
  const keys = parseServiceApiKeys(rawKeys);
  const lookup = new Map<string, ServiceApiKey>(keys.map((key) => [key.id, key]));
  return (apiKey: string) => lookup.get(apiKey);
}
