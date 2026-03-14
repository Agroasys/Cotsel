/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { EvidenceReadReader } from '../core/evidenceReadService';
import { GatewayError } from '../errors';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';

export interface RicardianRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  evidenceReadService: EvidenceReadReader;
}

export function createRicardianRouter(options: RicardianRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/ricardian/:tradeId', async (req, res, next) => {
    try {
      const tradeId = req.params.tradeId?.trim();
      if (!tradeId) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId is required');
      }

      const snapshot = await options.evidenceReadService.getRicardianDocument(tradeId);
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  router.get('/evidence/:tradeId', async (req, res, next) => {
    try {
      const tradeId = req.params.tradeId?.trim();
      if (!tradeId) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId is required');
      }

      const snapshot = await options.evidenceReadService.getTradeEvidence(tradeId);
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
