/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { decodeAuditFeedCursor } from '../core/auditFeedStore';
import { OperatorSettingsReadService } from '../core/operatorSettingsReadService';
import { decodeRoleAssignmentCursor } from '../core/roleAssignmentStore';
import { GatewayError } from '../errors';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';

export interface SettingsRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  settingsReadService: OperatorSettingsReadService;
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

function parseCursor(raw: unknown, decoder: (cursor: string) => unknown): string | undefined {
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
    decoder(raw);
  } catch (error) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return raw;
}

export function createSettingsRouter(options: SettingsRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/settings/role-assignments', async (req, res, next) => {
    try {
      const snapshot = await options.settingsReadService.listRoleAssignments({
        gatewayRole: parseString(req.query.gatewayRole, 'gatewayRole'),
        authRole: parseString(req.query.authRole, 'authRole'),
        limit: parseLimit(req.query.limit),
        cursor: parseCursor(req.query.cursor, decodeRoleAssignmentCursor),
      });
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/audit-feed', async (req, res, next) => {
    try {
      const snapshot = await options.settingsReadService.listAuditFeed({
        eventType: parseString(req.query.eventType, 'eventType'),
        actorUserId: parseString(req.query.actorUserId, 'actorUserId'),
        limit: parseLimit(req.query.limit),
        cursor: parseCursor(req.query.cursor, decodeAuditFeedCursor),
      });
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
