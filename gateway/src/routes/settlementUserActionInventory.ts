/** SPDX-License-Identifier: Apache-2.0 */
import { Router } from 'express';
import type { ReadUserActionInventory } from '../core/userActionEngine/inventory';
import { GatewayError } from '../errors';
import { successResponse } from '../responses';
/** Mounted AFTER the existing service-auth middleware. No execution capability. */
export function createUserActionInventoryRouter(read: ReadUserActionInventory | undefined): Router {
  const router = Router();
  router.get(
    '/settlement/gasless-executions/user-action/operations/:sourceOperationId',
    (req, res, next) => {
      void (async () => {
        const operation = String(req.params.sourceOperationId);
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            operation,
          ) ||
          Object.keys(req.query).length
        )
          throw new GatewayError(
            400,
            'VALIDATION_ERROR',
            'A canonical source operation UUID without query overrides is required',
          );
        const owner = req.serviceAuth?.apiKeyId;
        if (!owner)
          throw new GatewayError(401, 'AUTH_REQUIRED', 'Service authentication is required');
        if (!read)
          throw new GatewayError(
            503,
            'UPSTREAM_UNAVAILABLE',
            'User-action inventory is unavailable',
          );
        const inventory = await read(owner, operation);
        if (!inventory)
          throw new GatewayError(404, 'NOT_FOUND', 'User-action operation was not found');
        res.json(successResponse(inventory));
      })().catch(next);
    },
  );
  return router;
}
