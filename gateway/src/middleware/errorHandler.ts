/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';
import { errorResponse } from '../responses';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(
    errorResponse(req.requestContext, 'NOT_FOUND', 'Route not found', {
      route: req.originalUrl || req.path,
      method: req.method,
    }),
  );
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestContext?.requestId;
  const correlationId = req.requestContext?.correlationId;

  if (err instanceof GatewayError) {
    Logger.warn('Gateway error response', {
      requestId,
      correlationId,
      route: req.originalUrl || req.path,
      method: req.method,
      statusCode: err.statusCode,
      errorCode: err.code,
      details: err.details,
    });

    res.status(err.statusCode).json(errorResponse(req.requestContext, err.code, err.message, err.details));
    return;
  }

  Logger.error('Unhandled gateway error', {
    requestId,
    correlationId,
    route: req.originalUrl || req.path,
    method: req.method,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  res.status(500).json(errorResponse(req.requestContext, 'INTERNAL_ERROR', 'An unexpected error occurred'));
}
