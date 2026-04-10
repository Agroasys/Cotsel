/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { type AccessLogReader, validateAccessLogCreateRequest } from '../core/accessLogService';
import { decodeAccessLogCursor } from '../core/accessLogStore';
import { IdempotencyStore } from '../core/idempotencyStore';
import { GatewayError } from '../errors';
import {
  createAuthenticationMiddleware,
  requireGatewayRole,
  requireMutationWriteAccess,
} from '../middleware/auth';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { successResponse } from '../responses';

export interface AccessLogRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  accessLogService: AccessLogReader;
  idempotencyStore: IdempotencyStore;
}

function getPathParam(value: string | string[] | undefined, field: string): string | undefined {
  if (Array.isArray(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `Path parameter ${field} must be a string`);
  }

  return value;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return 50;
  }

  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'limit' must be an integer");
  }

  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      "Query parameter 'limit' must be between 1 and 200",
    );
  }

  return limit;
}

function parseString(raw: unknown, field: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      `Query parameter '${field}' must be a non-empty string`,
    );
  }

  return raw.trim();
}

function parseCursor(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      "Query parameter 'cursor' must be a non-empty string",
    );
  }

  try {
    decodeAccessLogCursor(raw);
  } catch (error) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return raw;
}

export function createAccessLogRouter(options: AccessLogRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);
  const idempotency = createIdempotencyMiddleware(options.idempotencyStore);

  router.get(
    '/access-logs',
    authenticate,
    requireGatewayRole('operator:read'),
    async (req, res, next) => {
      try {
        const snapshot = await options.accessLogService.list({
          eventType: parseString(req.query.eventType, 'eventType'),
          outcome: parseString(req.query.outcome, 'outcome'),
          actorUserId: parseString(req.query.actorUserId, 'actorUserId'),
          limit: parseLimit(req.query.limit),
          cursor: parseCursor(req.query.cursor),
        });
        res.status(200).json(successResponse(snapshot));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/access-logs/:entryId',
    authenticate,
    requireGatewayRole('operator:read'),
    async (req, res, next) => {
      try {
        const entryId = getPathParam(req.params.entryId, 'entryId')?.trim();
        if (!entryId) {
          throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter entryId is required');
        }

        const snapshot = await options.accessLogService.get(entryId);
        res.status(200).json(successResponse(snapshot));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/access-logs',
    authenticate,
    requireMutationWriteAccess(),
    idempotency,
    async (req, res, next) => {
      try {
        if (!req.gatewayPrincipal) {
          throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
        }

        if (!req.requestContext) {
          throw new GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
        }

        const created = await options.accessLogService.record(
          validateAccessLogCreateRequest(req.body),
          req.gatewayPrincipal,
          req.requestContext,
          req,
        );
        res.status(201).json(
          successResponse({
            item: created,
            freshness: {
              source: 'gateway_access_log' as const,
              sourceFreshAt: created.createdAt,
              queriedAt: new Date().toISOString(),
              available: true,
            },
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
