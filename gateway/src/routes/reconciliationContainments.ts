/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contained trades with their signed reconciliation evidence verified by the
 * gateway (Cotsel#951). Read-only; governance acts through the unpause routes.
 */
import { Router } from 'express';
import type { GatewayConfig } from '../config/env';
import type { AuthSessionClient } from '../core/authSessionClient';
import type { ContainmentEvidenceService } from '../core/containmentEvidence';
import type { FreezeReviewStore } from '../core/freezeReviewStore';
import { GatewayError } from '../errors';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';

export interface ReconciliationContainmentRouterOptions {
  freezeReviewStore?: FreezeReviewStore;
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  containmentEvidence: ContainmentEvidenceService;
}

function parseTradeId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9]{1,78}$/u.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId must be a trade id');
  }
  return raw;
}

export function createReconciliationContainmentRouter(
  options: ReconciliationContainmentRouterOptions,
): Router {
  const router = Router();
  router.use(
    '/reconciliation/containments',
    createAuthenticationMiddleware(options.authSessionClient, options.config),
    requireGatewayRole('operator:read'),
  );

  router.get('/reconciliation/containments', async (req, res, next) => {
    try {
      if (
        (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') ||
        (req.query.limit !== undefined && typeof req.query.limit !== 'string')
      )
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Invalid containment page parameters');
      const page = await options.containmentEvidence.listPage({
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        cursor: req.query.cursor,
      });
      const statuses = await options.freezeReviewStore?.statuses(
        page.items.flatMap((item) => (item.freezeRequestId ? [item.freezeRequestId] : [])),
      );
      res.status(200).json(
        successResponse({
          ...page,
          items: page.items.map((item) => ({
            ...item,
            freezeReview: item.freezeRequestId ? (statuses?.[item.freezeRequestId] ?? null) : null,
          })),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/reconciliation/containments/:tradeId', async (req, res, next) => {
    try {
      const tradeId = parseTradeId(req.params.tradeId);
      const containment = await options.containmentEvidence.get(tradeId);
      if (!containment) {
        throw new GatewayError(404, 'NOT_FOUND', 'The trade has no reconciliation containment', {
          tradeId,
        });
      }
      res.status(200).json(successResponse(containment));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
