/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  createAuthenticationMiddleware,
  requireGatewayRole,
  requireMutationWriteAccess,
  requireOperatorActionCapability,
} from '../middleware/auth';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { successResponse } from '../responses';
import { GovernanceMutationPreflightReader } from '../core/governanceStatusService';
import { GovernanceMutationService } from '../core/governanceMutationService';
import {
  GOVERNANCE_ACTION_CATEGORIES,
  GOVERNANCE_ACTION_STATUSES,
  GovernanceActionStore,
} from '../core/governanceStore';
import { IdempotencyStore } from '../core/idempotencyStore';
import { GatewayError } from '../errors';
import { registerGovernanceDirectSignRoutes } from './governanceDirectSignMutations';

export interface GovernanceRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  governanceStatusService: GovernanceMutationPreflightReader;
  governanceActionStore: GovernanceActionStore;
  governanceMutationService: GovernanceMutationService;
  idempotencyStore: IdempotencyStore;
}

function optionalEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} is invalid`);
  }
  return raw as T;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return 50;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'limit must be an integer');
  }
  const limit = Number.parseInt(raw, 10);
  if (limit < 1 || limit > 100) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'limit must be between 1 and 100');
  }
  return limit;
}

export function createGovernanceRouter(options: GovernanceRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  // Protocol state and active proposals are read live from chain. The immutable
  // action log is served separately from the access-log feed (`/access-logs`).
  router.get(
    '/governance/status',
    authenticate,
    requireGatewayRole('operator:read'),
    async (_req, res, next) => {
      try {
        const status = await options.governanceStatusService.getGovernanceStatus();
        res.status(200).json(successResponse(status));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/governance/actions',
    authenticate,
    requireGatewayRole('operator:read'),
    async (req, res, next) => {
      try {
        const category = optionalEnum(req.query.category, GOVERNANCE_ACTION_CATEGORIES, 'category');
        const status = optionalEnum(req.query.status, GOVERNANCE_ACTION_STATUSES, 'status');
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
        const result = await options.governanceActionStore.list({
          category,
          status,
          limit: parseLimit(req.query.limit),
          cursor,
        });
        res.status(200).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/governance/actions/:actionId',
    authenticate,
    requireGatewayRole('operator:read'),
    async (req, res, next) => {
      try {
        const actionId = typeof req.params.actionId === 'string' ? req.params.actionId : '';
        const action = actionId ? await options.governanceActionStore.get(actionId) : null;
        if (!action) {
          throw new GatewayError(404, 'NOT_FOUND', 'Governance action not found');
        }
        res.status(200).json(successResponse(action));
      } catch (error) {
        next(error);
      }
    },
  );

  const mutationRouter = Router();
  mutationRouter.use(
    '/governance',
    authenticate,
    requireMutationWriteAccess(),
    requireOperatorActionCapability('governance:write'),
  );
  registerGovernanceDirectSignRoutes(
    mutationRouter,
    createIdempotencyMiddleware(options.idempotencyStore),
    {
      config: options.config,
      governanceReader: options.governanceStatusService,
      mutationService: options.governanceMutationService,
    },
  );
  router.use(mutationRouter);

  return router;
}
