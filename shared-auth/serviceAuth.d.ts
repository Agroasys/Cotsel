import { NextFunction, Request, Response } from 'express';

export interface ServiceApiKey {
  id: string;
  secret: string;
  active: boolean;
  humanPrincipalId?: string;
}

export interface ServiceAuthContext {
  apiKeyId: string;
  scheme: 'api_key' | 'shared_secret';
  humanPrincipalId?: string;
}

export interface ServiceAuthMiddlewareOptions {
  enabled: boolean;
  maxSkewSeconds: number;
  nonceTtlSeconds: number;
  sharedSecret?: string;
  nowSeconds?: () => number;
  lookupApiKey: (apiKey: string) => ServiceApiKey | undefined;
  consumeNonce: (apiKey: string, nonce: string, ttlSeconds: number) => Promise<boolean>;
  onAuthFailure?: (reason: string) => void;
  onReplayReject?: () => void;
}

export interface CanonicalRequestParts {
  method: string;
  path: string;
  query: string;
  bodySha256: string;
  timestamp: string;
  nonce: string;
}

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
  serviceAuth?: ServiceAuthContext;
}

export function buildServiceAuthCanonicalString(parts: CanonicalRequestParts): string;
export function signServiceAuthCanonicalString(secret: string, canonicalString: string): string;
export function parseServiceApiKeys(raw: string | undefined): ServiceApiKey[];
export function createServiceAuthMiddleware(
  options: ServiceAuthMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void>;
