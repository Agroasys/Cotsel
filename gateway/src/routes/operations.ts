/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import type { GaslessSettlementExecutionService } from '../core/gaslessSettlementExecutionService';
import { OperationsSummaryReader } from '../core/operationsSummaryService';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';

export interface OperationsRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  operationsSummaryService: OperationsSummaryReader;
  gaslessSettlementService?: GaslessSettlementExecutionService | null;
}

export function createOperationsRouter(options: OperationsRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use('/operations', authenticate, requireGatewayRole('operator:read'));

  const respondWithOperationsSummary = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const snapshot = await options.operationsSummaryService.getOperationsSummary();
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  };

  router.get('/operations', respondWithOperationsSummary);
  router.get('/operations/summary', respondWithOperationsSummary);
  router.get('/operations/gasless-relayer/readiness', (_req, res) => {
    if (!options.gaslessSettlementService) {
      res.status(200).json(
        successResponse({
          enabled: false,
          state: 'disabled',
          generatedAt: new Date().toISOString(),
          reason: 'GATEWAY_GASLESS_EXECUTION_ENABLED is false',
        }),
      );
      return;
    }

    res.status(200).json(successResponse(options.gaslessSettlementService.getRelayerReadiness()));
  });

  return router;
}
