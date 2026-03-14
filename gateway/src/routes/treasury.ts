/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  GOVERNANCE_ACTION_STATUSES,
  GovernanceActionStatus,
} from '../core/governanceStore';
import {
  TREASURY_ACTION_CATEGORIES,
  TreasuryActionCategory,
  TreasuryReadReader,
} from '../core/treasuryReadService';
import { GatewayError } from '../errors';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';
import { decodeGovernanceActionCursor } from '../core/governanceStore';

export interface TreasuryRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  treasuryReadService: TreasuryReadReader;
}

function parseEnum<T extends string>(
  raw: unknown,
  values: readonly T[],
  field: string,
): T | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || !values.includes(raw as T)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `Query parameter '${field}' is invalid`, {
      field,
      allowed: values,
    });
  }

  return raw as T;
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
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'limit' must be between 1 and 200");
  }

  return limit;
}

function parseCursor(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' must be a non-empty string");
  }

  try {
    decodeGovernanceActionCursor(raw);
  } catch (error) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return raw;
}

export function createTreasuryRouter(options: TreasuryRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/treasury', async (_req, res, next) => {
    try {
      const snapshot = await options.treasuryReadService.getTreasurySnapshot();
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  router.get('/treasury/actions', async (req, res, next) => {
    try {
      const result = await options.treasuryReadService.listTreasuryActions({
        category: parseEnum<TreasuryActionCategory>(
          req.query.category,
          TREASURY_ACTION_CATEGORIES,
          'category',
        ),
        status: parseEnum<GovernanceActionStatus>(
          req.query.status,
          GOVERNANCE_ACTION_STATUSES,
          'status',
        ),
        limit: parseLimit(req.query.limit),
        cursor: parseCursor(req.query.cursor),
      });

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
