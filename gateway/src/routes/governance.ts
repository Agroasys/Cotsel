/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  createAuthenticationMiddleware,
  requireGatewayRole,
} from '../middleware/auth';
import { successResponse } from '../responses';
import {
  decodeGovernanceActionCursor,
  GOVERNANCE_ACTION_CATEGORIES,
  GOVERNANCE_ACTION_STATUSES,
  GovernanceActionStore,
} from '../core/governanceStore';
import { EscrowGovernanceReader } from '../core/governanceStatusService';
import { GatewayError } from '../errors';

export interface GovernanceRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  governanceStatusService: EscrowGovernanceReader;
  governanceActionStore: GovernanceActionStore;
}

function parseEnum<T extends string>(
  raw: unknown,
  values: readonly T[],
  field: string,
): T | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || !values.includes(raw as T)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `Query parameter '${field}' is invalid`, {
      field,
      allowed: values,
    });
  }

  return raw as T;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return 50;
  }

  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'limit' must be an integer");
  }

  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'limit' must be between 1 and 200");
  }

  return limit;
}

function parseCursor(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' must be a non-empty string");
  }

  try {
    decodeGovernanceActionCursor(raw);
  } catch (error) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return raw;
}

function parseTradeId(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'tradeId' must be a non-empty string");
  }

  return raw.trim();
}

export function createGovernanceRouter(options: GovernanceRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);

  router.use(authenticate, requireGatewayRole('operator:read'));

  router.get('/governance/status', async (_req, res, next) => {
    try {
      const [oracleProposalIds, treasuryPayoutReceiverProposalIds] = await Promise.all([
        options.governanceActionStore.listActiveProposalIds('oracle_update'),
        options.governanceActionStore.listActiveProposalIds('treasury_payout_receiver_update'),
      ]);
      const status = await options.governanceStatusService.getGovernanceStatus({
        oracleProposalIds,
        treasuryPayoutReceiverProposalIds,
      });
      res.status(200).json(successResponse(status));
    } catch (error) {
      next(error);
    }
  });

  router.get('/governance/actions', async (req, res, next) => {
    try {
      const result = await options.governanceActionStore.list({
        category: parseEnum(req.query.category, GOVERNANCE_ACTION_CATEGORIES, 'category'),
        status: parseEnum(req.query.status, GOVERNANCE_ACTION_STATUSES, 'status'),
        tradeId: parseTradeId(req.query.tradeId),
        limit: parseLimit(req.query.limit),
        cursor: parseCursor(req.query.cursor),
      });

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.get('/governance/actions/:actionId', async (req, res, next) => {
    try {
      const actionId = req.params.actionId?.trim();
      if (!actionId) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter actionId is required');
      }

      const action = await options.governanceActionStore.get(actionId);
      if (!action) {
        throw new GatewayError(404, 'NOT_FOUND', 'Governance action not found', {
          actionId,
        });
      }

      res.status(200).json(successResponse(action));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
