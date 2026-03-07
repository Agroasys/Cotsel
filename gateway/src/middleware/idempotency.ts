/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import { GatewayError } from '../errors';
import { buildRequestFingerprint, IdempotencyStore } from '../core/idempotencyStore';

export interface IdempotencyRequestState {
  idempotencyKey: string;
  requestFingerprint: string;
}

function normalizeBody(body: unknown): unknown {
  if (body === undefined) {
    return null;
  }

  if (Buffer.isBuffer(body)) {
    const asText = body.toString('utf8');
    try {
      return JSON.parse(asText);
    } catch {
      return asText;
    }
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  return body;
}

function replayHeaders(res: Response): Record<string, string> {
  const headerNames = ['content-type'];
  const snapshot: Record<string, string> = {};

  for (const name of headerNames) {
    const value = res.getHeader(name);
    if (typeof value === 'string') {
      snapshot[name] = value;
    }
  }

  return snapshot;
}

export function createIdempotencyMiddleware(store: IdempotencyStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey) {
      next(new GatewayError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required for mutation routes'));
      return;
    }

    const requestPath = req.originalUrl || req.path;
    const requestFingerprint = buildRequestFingerprint(req.method, requestPath, req.rawBody);
    const existing = await store.get(idempotencyKey);

    if (existing) {
      if (
        existing.requestFingerprint !== requestFingerprint ||
        existing.requestMethod !== req.method ||
        existing.requestPath !== requestPath
      ) {
        next(new GatewayError(409, 'CONFLICT', 'Idempotency key is already in use for a different request', {
          idempotencyKey,
        }));
        return;
      }

      if (existing.completedAt && existing.responseStatus !== null) {
        await store.markReplay(idempotencyKey);
        res.setHeader('x-idempotent-replay', 'true');
        if (existing.responseHeaders['content-type']) {
          res.setHeader('content-type', existing.responseHeaders['content-type']);
        }
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }

      next(new GatewayError(409, 'CONFLICT', 'A request with this idempotency key is already in progress', {
        idempotencyKey,
      }));
      return;
    }

    await store.createPending({
      idempotencyKey,
      requestMethod: req.method,
      requestPath,
      requestFingerprint,
      requestId: req.requestContext?.requestId || 'unknown',
    });

    req.idempotencyState = {
      idempotencyKey,
      requestFingerprint,
    };

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let responseBody: unknown = null;

    res.json = ((body: unknown) => {
      responseBody = body;
      return originalJson(body);
    }) as Response['json'];

    res.send = ((body: unknown) => {
      if (responseBody === null) {
        responseBody = normalizeBody(body);
      }
      return originalSend(body);
    }) as Response['send'];

    res.on('finish', () => {
      if (res.statusCode >= 500) {
        return;
      }

      void store.complete(idempotencyKey, {
        responseStatus: res.statusCode,
        responseHeaders: replayHeaders(res),
        responseBody,
      });
    });

    next();
  };
}
