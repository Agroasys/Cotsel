import { Request, Response, NextFunction } from 'express';
import { failure, sendInternalFailure } from '@agroasys/shared-http';
import { config } from '../config';
import { consumeHmacNonce } from '../database/queries';
import { Logger } from '../utils/logger';
import { ErrorResponse } from '../types';
import {
  deriveRequestNonce,
  hashSignature,
  RequestBodyBytes,
  verifyRequestSignature,
} from '../utils/crypto';

// Body-less requests carry no bytes to bind. Existing callers (the
// agroasys-backend Oracle read bridge) sign this placeholder for them, so it
// stays accepted for body-less requests only, until they sign the empty body.
const LEGACY_EMPTY_BODY_SIGNING_FORM = '{}';

// express.json `verify` hook: keep the exact received bytes so the HMAC is
// checked against them rather than a reserialized JSON body (WP-2 H-22).
export function captureRawJsonBody(req: Request, _res: Response, body: Buffer): void {
  req.rawBody = Buffer.from(body);
}

function isInvalidSignatureError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Invalid HMAC signature';
}

// Verifies the signature over the received bytes and returns the body form
// that was signed, so the derived nonce matches what the caller computed.
function verifyReceivedBody(req: Request, timestamp: string, signature: string): RequestBodyBytes {
  const received = req.rawBody ?? Buffer.alloc(0);
  if (received.length > 0) {
    verifyRequestSignature(timestamp, received, signature, config.hmacSecret);
    return received;
  }

  try {
    verifyRequestSignature(timestamp, received, signature, config.hmacSecret);
    return received;
  } catch (error: unknown) {
    if (!isInvalidSignatureError(error)) {
      throw error;
    }
  }

  verifyRequestSignature(timestamp, LEGACY_EMPTY_BODY_SIGNING_FORM, signature, config.hmacSecret);
  return LEGACY_EMPTY_BODY_SIGNING_FORM;
}

function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader) {
    return null;
  }

  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.replace('Bearer ', '');
}

export function authMiddleware(
  req: Request,
  res: Response<ErrorResponse>,
  next: NextFunction,
): void {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    Logger.warn('Missing authorization header', { ip: req.ip });
    res.status(401).json(failure('Unauthorized', 'Missing authorization header'));
    return;
  }

  if (token !== config.apiKey) {
    Logger.warn('Invalid API key', { ip: req.ip });
    res.status(401).json(failure('Unauthorized', 'Invalid API key'));
    return;
  }

  req.apiKeyToken = token;
  next();
}

export async function hmacMiddleware(
  req: Request,
  res: Response<ErrorResponse>,
  next: NextFunction,
): Promise<void> {
  const timestamp = req.headers['x-timestamp'] as string;
  const signature = req.headers['x-signature'] as string;
  const providedNonce = (req.headers['x-nonce'] as string | undefined)?.trim();
  const apiKeyToken =
    req.apiKeyToken || extractBearerToken(req.headers.authorization) || 'oracle-service';

  if (!timestamp || !signature) {
    Logger.warn('Missing HMAC headers', { ip: req.ip });
    res.status(401).json(failure('Unauthorized', 'Missing X-Timestamp or X-Signature headers'));
    return;
  }

  try {
    const body = verifyReceivedBody(req, timestamp, signature);
    const nonce = providedNonce || deriveRequestNonce(timestamp, body, signature);

    if (!nonce || nonce.length > 255) {
      Logger.warn('Invalid nonce format', { ip: req.ip });
      res.status(401).json(failure('Unauthorized', 'Invalid X-Nonce header'));
      return;
    }

    const nonceAccepted = await consumeHmacNonce(apiKeyToken, nonce, config.hmacNonceTtlSeconds);
    if (!nonceAccepted) {
      Logger.warn('Replay detected for nonce', {
        ip: req.ip,
        nonce: nonce.substring(0, 16) + '...',
      });
      res.status(401).json(failure('Unauthorized', 'Replay detected for nonce'));
      return;
    }

    req.hmacSignature = signature;
    req.hmacNonce = nonce;

    Logger.info('HMAC signature verified', {
      timestamp,
      ip: req.ip,
      nonce: nonce.substring(0, 16) + '...',
      signatureHash: hashSignature(signature),
    });

    next();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimestampOrSignatureError =
      errorMessage.includes('Request timestamp') || errorMessage.includes('Invalid HMAC signature');

    if (!isTimestampOrSignatureError) {
      Logger.error('HMAC nonce persistence failed', {
        error: errorMessage,
        ip: req.ip,
      });
      res.status(503).json(failure('ServiceUnavailable', 'Authentication nonce store unavailable'));
      return;
    }

    Logger.warn('HMAC verification failed', {
      error: errorMessage,
      ip: req.ip,
    });
    res.status(401).json(failure('Unauthorized', errorMessage));
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response<ErrorResponse>,
  _next: NextFunction,
): void {
  // WP-10 I-06: the raw error is logged under the correlation ID, never returned.
  sendInternalFailure(req, res, err, {
    code: 'InternalServerError',
    log: (correlationId, cause) =>
      Logger.error('Unhandled error', {
        correlationId,
        route: req.path,
        error: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack : undefined,
      }),
  });
}
