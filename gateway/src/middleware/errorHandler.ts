/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';
import { errorResponse } from '../responses';
import { createGatewayErrorEnvelope } from '../core/errorEnvelope';
import { persistIdempotentError } from './idempotency';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(
    errorResponse(req.requestContext, 'NOT_FOUND', 'Route not found', {
      route: req.originalUrl || req.path,
      method: req.method,
    }),
  );
}

export async function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  const envelope = createGatewayErrorEnvelope(err, req.requestContext);
  const requestId = envelope.requestId;
  const correlationId = envelope.traceId;

  if (err instanceof GatewayError) {
    Logger.warn('Gateway error response', {
      requestId,
      correlationId,
      route: req.originalUrl || req.path,
      method: req.method,
      statusCode: envelope.statusCode,
      errorCode: envelope.code,
      failureClass: envelope.failureClass,
      retryable: envelope.retryable,
      replayable: envelope.replayable,
      details: envelope.details,
    });

    const response = errorResponse(
      req.requestContext,
      envelope.code,
      envelope.message,
      envelope.details,
    );
    try {
      await persistIdempotentError(res, envelope.statusCode, response);
    } catch (persistenceError) {
      Logger.error('Failed to finalize idempotency state before error response', {
        requestId,
        correlationId,
        error:
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
      });
      res
        .status(503)
        .json(
          errorResponse(
            req.requestContext,
            'UPSTREAM_UNAVAILABLE',
            'Durable request state is unavailable',
          ),
        );
      return;
    }
    res.status(envelope.statusCode).json(response);
    return;
  }

  Logger.error('Unhandled gateway error', {
    requestId,
    correlationId,
    route: req.originalUrl || req.path,
    method: req.method,
    failureClass: envelope.failureClass,
    retryable: envelope.retryable,
    replayable: envelope.replayable,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  const response = errorResponse(
    req.requestContext,
    'INTERNAL_ERROR',
    'An unexpected error occurred',
  );
  try {
    await persistIdempotentError(res, 500, response);
  } catch (persistenceError) {
    Logger.error('Failed to release idempotency state after unexpected error', {
      requestId,
      correlationId,
      error:
        persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
    });
  }
  res.status(500).json(response);
}
