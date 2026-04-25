/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { TradeReadReader } from '../core/tradeReadService';
import { GatewayError } from '../errors';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';

export interface TradeRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  tradeReadService: TradeReadReader;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return 100;
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

function parseOffset(raw: unknown): number {
  if (raw === undefined) {
    return 0;
  }

  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'offset' must be an integer");
  }

  const offset = Number.parseInt(raw, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      "Query parameter 'offset' must be zero or greater",
    );
  }

  return offset;
}

export function createTradeRouter(options: TradeRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/trades', async (req, res, next) => {
    try {
      const snapshot = await options.tradeReadService.listTradesSnapshot(
        parseLimit(req.query.limit),
        parseOffset(req.query.offset),
      );
      res.status(200).json({
        ...successResponse(snapshot.items),
        freshness: snapshot.freshness,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/trades/:tradeId', async (req, res, next) => {
    try {
      const tradeId = req.params.tradeId?.trim();
      if (!tradeId) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId is required');
      }

      const snapshot = await options.tradeReadService.getTradeSnapshot(tradeId);
      if (!snapshot.item) {
        throw new GatewayError(404, 'NOT_FOUND', 'Trade not found', { tradeId });
      }

      res.status(200).json({
        ...successResponse(snapshot.item),
        freshness: snapshot.freshness,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
