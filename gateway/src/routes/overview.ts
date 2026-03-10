/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { OverviewReader } from '../core/overviewService';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';

export interface OverviewRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  overviewService: OverviewReader;
}

export function createOverviewRouter(options: OverviewRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/overview', async (_req, res, next) => {
    try {
      const snapshot = await options.overviewService.getOverview();
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
