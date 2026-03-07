/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  ComplianceService,
  validateComplianceDecisionCreateRequest,
  validateComplianceOperationalControlRequest,
} from '../core/complianceService';
import { decodeComplianceDecisionCursor } from '../core/complianceStore';
import { IdempotencyStore } from '../core/idempotencyStore';
import { GatewayError } from '../errors';
import {
  createAuthenticationMiddleware,
  requireGatewayRole,
  requireMutationWriteAccess,
  type GatewayPrincipal,
} from '../middleware/auth';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { type RequestContext } from '../middleware/requestContext';
import { successResponse } from '../responses';

export interface ComplianceRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  complianceService: ComplianceService;
  idempotencyStore: IdempotencyStore;
}

type MutationRequest = Request<
  Record<string, string | string[]>,
  unknown,
  Record<string, unknown>
>;

interface MutationContext {
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  idempotencyKey: string;
}

function parseTradeId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter tradeId is required');
  }

  return raw.trim();
}

function parseDecisionId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter decisionId is required');
  }

  return raw.trim();
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
    decodeComplianceDecisionCursor(raw);
  } catch (error) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'cursor' is invalid", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return raw;
}

function getMutationContext(req: MutationRequest): MutationContext {
  if (!req.gatewayPrincipal) {
    throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
  }

  if (!req.requestContext) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
  }

  if (!req.idempotencyState?.idempotencyKey) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Idempotency context was not initialized');
  }

  return {
    principal: req.gatewayPrincipal,
    requestContext: req.requestContext,
    idempotencyKey: req.idempotencyState.idempotencyKey,
  };
}

async function handleMutation(
  req: MutationRequest,
  res: Response,
  next: NextFunction,
  statusCode: number,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await operation();
    res.status(statusCode).json(successResponse(result));
  } catch (error) {
    next(error);
  }
}

export function createComplianceRouter(options: ComplianceRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);
  const idempotency = createIdempotencyMiddleware(options.idempotencyStore);

  router.use(authenticate);

  router.get('/compliance/decisions/:decisionId', requireGatewayRole('operator:read'), async (req, res, next) => {
    try {
      const decisionId = parseDecisionId(req.params.decisionId);
      const decision = await options.complianceService.getDecision(decisionId);
      if (!decision) {
        throw new GatewayError(404, 'NOT_FOUND', 'Compliance decision not found', { decisionId });
      }

      res.status(200).json(successResponse(decision));
    } catch (error) {
      next(error);
    }
  });

  router.get('/compliance/trades/:tradeId', requireGatewayRole('operator:read'), async (req, res, next) => {
    try {
      const tradeId = parseTradeId(req.params.tradeId);
      const status = await options.complianceService.getTradeStatus(tradeId);
      if (!status) {
        throw new GatewayError(404, 'NOT_FOUND', 'Compliance status not found for trade', { tradeId });
      }

      res.status(200).json(successResponse(status));
    } catch (error) {
      next(error);
    }
  });

  router.get('/compliance/trades/:tradeId/decisions', requireGatewayRole('operator:read'), async (req, res, next) => {
    try {
      const tradeId = parseTradeId(req.params.tradeId);
      const latest = await options.complianceService.getTradeStatus(tradeId);
      if (!latest) {
        throw new GatewayError(404, 'NOT_FOUND', 'Compliance decision history not found for trade', { tradeId });
      }

      const result = await options.complianceService.listTradeDecisions(
        tradeId,
        parseLimit(req.query.limit),
        parseCursor(req.query.cursor),
      );

      res.status(200).json(successResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.post('/compliance/decisions', requireMutationWriteAccess(), idempotency, (req, res, next) => handleMutation(req, res, next, 201, async () => {
    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.complianceService.createDecision({
      ...validateComplianceDecisionCreateRequest(req.body),
      principal,
      requestContext,
      routePath: req.originalUrl || req.path,
      idempotencyKey,
    });
  }));

  router.post('/compliance/trades/:tradeId/block-oracle-progression', requireMutationWriteAccess(), idempotency, (req, res, next) => handleMutation(req, res, next, 202, async () => {
    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.complianceService.blockOracleProgression({
      ...validateComplianceOperationalControlRequest(req.body),
      tradeId: parseTradeId(req.params.tradeId),
      principal,
      requestContext,
      routePath: req.originalUrl || req.path,
      idempotencyKey,
    });
  }));

  router.post('/compliance/trades/:tradeId/resume-oracle-progression', requireMutationWriteAccess(), idempotency, (req, res, next) => handleMutation(req, res, next, 202, async () => {
    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.complianceService.resumeOracleProgression({
      ...validateComplianceOperationalControlRequest(req.body),
      tradeId: parseTradeId(req.params.tradeId),
      principal,
      requestContext,
      routePath: req.originalUrl || req.path,
      idempotencyKey,
    });
  }));

  return router;
}
