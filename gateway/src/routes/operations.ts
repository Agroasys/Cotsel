/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { OperationsSummaryReader } from '../core/operationsSummaryService';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';

export interface OperationsRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  operationsSummaryService: OperationsSummaryReader;
}

export function createOperationsRouter(options: OperationsRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/operations/summary', async (_req, res, next) => {
    try {
      const snapshot = await options.operationsSummaryService.getOperationsSummary();
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
