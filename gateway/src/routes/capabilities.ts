/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import type { GatewayConfig } from '../config/env';
import type { AuthSessionClient } from '../core/authSessionClient';
import { buildOperatorCapabilitySnapshot } from '../core/operatorCapabilities';
import { GatewayError } from '../errors';
import { createAuthenticationMiddleware } from '../middleware/auth';
import { successResponse } from '../responses';

export interface CapabilitiesRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
}

export function createCapabilitiesRouter(options: CapabilitiesRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate);

  router.get('/auth/capabilities', async (req, res, next) => {
    try {
      if (!req.gatewayPrincipal) {
        throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
      }

      const snapshot = buildOperatorCapabilitySnapshot(req.gatewayPrincipal, options.config);
      res.status(200).json(successResponse(snapshot));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
