/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  ReconciliationReadReader,
} from '../core/reconciliationReadService';
import {
  SETTLEMENT_EXECUTION_STATUSES,
  SETTLEMENT_RECONCILIATION_STATUSES,
} from '../core/settlementStore';
import { GatewayError } from '../errors';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';

export interface ReconciliationRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  reconciliationReadService: ReconciliationReadReader;
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

function parseTradeId(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'tradeId' must be a non-empty string");
  }

  return raw.trim();
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

function parseOffset(raw: unknown): number {
  if (raw === undefined) {
    return 0;
  }

  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'offset' must be an integer");
  }

  const offset = Number.parseInt(raw, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'offset' must be zero or greater");
  }

  return offset;
}

export function createReconciliationRouter(options: ReconciliationRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/reconciliation', async (req, res, next) => {
    try {
      const snapshot = await options.reconciliationReadService.listReconciliation({
        tradeId: parseTradeId(req.query.tradeId),
        reconciliationStatus: parseEnum(
          req.query.reconciliationStatus,
          SETTLEMENT_RECONCILIATION_STATUSES,
          'reconciliationStatus',
        ),
        executionStatus: parseEnum(
          req.query.executionStatus,
          SETTLEMENT_EXECUTION_STATUSES,
          'executionStatus',
        ),
        limit: parseLimit(req.query.limit),
        offset: parseOffset(req.query.offset),
      });

      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  router.get('/reconciliation/handoffs/:handoffId', async (req, res, next) => {
    try {
      const handoffId = req.params.handoffId?.trim();
      if (!handoffId) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter handoffId is required');
      }

      const snapshot = await options.reconciliationReadService.getReconciliationHandoff(handoffId);
      if (!snapshot.handoff && snapshot.freshness.available) {
        throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', { handoffId });
      }

      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
