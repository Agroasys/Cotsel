/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';
import { errorResponse } from '../responses';
import { createGatewayErrorEnvelope } from '../core/errorEnvelope';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(
    errorResponse(req.requestContext, 'NOT_FOUND', 'Route not found', {
      route: req.originalUrl || req.path,
      method: req.method,
    }),
  );
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
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

    res.status(envelope.statusCode).json(errorResponse(req.requestContext, envelope.code, envelope.message, envelope.details));
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

  res.status(500).json(errorResponse(req.requestContext, 'INTERNAL_ERROR', 'An unexpected error occurred'));
}
