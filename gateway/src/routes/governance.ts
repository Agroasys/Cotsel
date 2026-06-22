/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { createAuthenticationMiddleware, requireGatewayRole } from '../middleware/auth';
import { successResponse } from '../responses';
import { EscrowGovernanceReader } from '../core/governanceStatusService';

export interface GovernanceRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  governanceStatusService: EscrowGovernanceReader;
}

export function createGovernanceRouter(options: GovernanceRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use('/governance', authenticate, requireGatewayRole('operator:read'));

  // Protocol state and active proposals are read live from chain. The immutable
  // action log is served separately from the access-log feed (`/access-logs`).
  router.get('/governance/status', async (_req, res, next) => {
    try {
      const status = await options.governanceStatusService.getGovernanceStatus();
      res.status(200).json(successResponse(status));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
