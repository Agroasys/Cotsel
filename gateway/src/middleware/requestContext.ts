/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from '../logging/logger';

export interface RequestContext {
  requestId: string;
  correlationId: string;
  startedAtMs: number;
}

export function createRequestContextMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = headerValue(req.headers['x-request-id']) || randomUUID();
    const correlationId = headerValue(req.headers['x-correlation-id']) || requestId;
    const startedAtMs = Date.now();

    req.requestContext = { requestId, correlationId, startedAtMs };
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-correlation-id', correlationId);

    Logger.info('Request started', {
      requestId,
      correlationId,
      route: req.originalUrl || req.path,
      method: req.method,
    });

    res.on('finish', () => {
      Logger.info('Request completed', {
        requestId,
        correlationId,
        route: req.originalUrl || req.path,
        method: req.method,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAtMs,
      });
    });

    next();
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0]?.trim() : value?.trim();
  // Do not reflect arbitrary caller-controlled strings in response bodies,
  // headers or telemetry. Match the shared HTTP correlation-ID contract.
  return candidate && /^[A-Za-z0-9._:-]{8,128}$/u.test(candidate) ? candidate : undefined;
}
