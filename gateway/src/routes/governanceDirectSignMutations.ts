/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { RequestHandler, Router } from 'express';
import { GatewayError } from '../errors';
import { confirmAndRespond, getPathParam } from './governanceMutationRouteSupport';
import { registerGovernanceCorePrepareRoutes } from './governanceCorePrepareRoutes';
import { registerGovernanceOraclePrepareRoutes } from './governanceOraclePrepareRoutes';
import { registerGovernanceTreasuryPrepareRoutes } from './governanceTreasuryPrepareRoutes';
import type { GovernanceDirectSignRouterOptions } from './governanceDirectSignRouteTypes';

export type { GovernanceDirectSignRouterOptions } from './governanceDirectSignRouteTypes';

export function registerGovernanceDirectSignRoutes(
  router: Router,
  idempotency: RequestHandler,
  options: GovernanceDirectSignRouterOptions,
): void {
  registerGovernanceCorePrepareRoutes(router, idempotency, options);
  registerGovernanceTreasuryPrepareRoutes(router, idempotency, options);
  registerGovernanceOraclePrepareRoutes(router, idempotency, options);

  router.post('/governance/actions/:actionId/confirm', (req, res, next) =>
    confirmAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      if (!req.gatewayPrincipal) {
        throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
      }
      if (!req.requestContext) {
        throw new GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
      }

      const actionId = getPathParam(req.params.actionId, 'actionId');
      if (!actionId) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter actionId is required');
      }

      const body = req.body as Record<string, unknown>;
      if (typeof body?.txHash !== 'string' || !body.txHash) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'txHash is required');
      }

      return options.mutationService.confirmBroadcast({
        actionId,
        txHash: body.txHash,
        signerWallet,
        principal: req.gatewayPrincipal,
        signerBinding,
        requestContext: req.requestContext,
      });
    }),
  );
}
