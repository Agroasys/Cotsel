/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  FailedOperationState,
  FailedOperationStore,
  type FailedOperationRecord,
} from '../core/failedOperationStore';
import { GatewayFailedOperationReplayer } from '../core/errorHandlerWorkflow';
import type { GaslessSettlementExecutionService } from '../core/gaslessSettlementExecutionService';
import type { GaslessCommandRecord } from '../core/gaslessCommandStore';
import { IdempotencyStore } from '../core/idempotencyStore';
import { OperationsSummaryReader } from '../core/operationsSummaryService';
import {
  createAuthenticationMiddleware,
  requireOperatorActionCapability,
  requireGatewayRole,
  requireMutationWriteAccess,
} from '../middleware/auth';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { successResponse } from '../responses';
import { GatewayError } from '../errors';

export interface OperationsRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  operationsSummaryService: OperationsSummaryReader;
  gaslessSettlementService?: GaslessSettlementExecutionService | null;
  failedOperationStore?: FailedOperationStore | null;
  failedOperationReplayer?: GatewayFailedOperationReplayer | null;
  idempotencyStore?: IdempotencyStore | null;
}

const FAILED_OPERATION_STATES: readonly FailedOperationState[] = [
  'open',
  'replayed',
  'replay_failed',
];

function parseFailedOperationState(raw: unknown): FailedOperationState | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !FAILED_OPERATION_STATES.includes(raw as FailedOperationState)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'failureState' is invalid", {
      allowed: FAILED_OPERATION_STATES,
    });
  }
  return raw as FailedOperationState;
}

function parseReplayEligible(raw: unknown): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new GatewayError(
    400,
    'VALIDATION_ERROR',
    "Query parameter 'replayEligible' must be true or false",
  );
}

function requireFailedOperationStore(
  store: FailedOperationStore | null | undefined,
): FailedOperationStore {
  if (!store) {
    throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Failed-operation queue is not configured');
  }
  return store;
}

function parseFailedOperationId(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter failedOperationId is required');
  }
  return raw.trim();
}

function parseGaslessCommandId(raw: string | string[] | undefined): string {
  const commandId = typeof raw === 'string' ? raw.trim() : '';
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId)
  ) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter commandId must be a UUID');
  }
  return commandId;
}

function parseDeadLetterLimit(raw: unknown): number {
  if (raw === undefined) return 100;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', "Query parameter 'limit' must be an integer");
  }
  const limit = Number(raw);
  if (limit < 1 || limit > 100) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      "Query parameter 'limit' must be from 1 to 100",
    );
  }
  return limit;
}

function sanitizeGaslessCommand(record: GaslessCommandRecord) {
  const { payload: _payload, result: _result, ...safeRecord } = record;
  return safeRecord;
}

function sanitizeFailedOperation(record: FailedOperationRecord) {
  return {
    ...record,
    requestPayload: null,
  };
}

async function requireReplayableFailedOperation(
  store: FailedOperationStore | null | undefined,
  failedOperationId: string,
): Promise<FailedOperationRecord> {
  const record = await requireFailedOperationStore(store).get(failedOperationId);
  if (!record) {
    throw new GatewayError(404, 'NOT_FOUND', 'Failed operation not found', {
      failedOperationId,
    });
  }

  if (!record.replayEligible || record.failureState !== 'open') {
    throw new GatewayError(409, 'CONFLICT', 'Failed operation is not replayable', {
      failedOperationId,
      replayEligible: record.replayEligible,
      failureState: record.failureState,
    });
  }

  return record;
}

export function createOperationsRouter(options: OperationsRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);
  const replayIdempotency = options.idempotencyStore
    ? createIdempotencyMiddleware(options.idempotencyStore)
    : (_req: Request, _res: Response, next: NextFunction) =>
        next(
          new GatewayError(
            503,
            'UPSTREAM_UNAVAILABLE',
            'Operator replay idempotency is not configured',
          ),
        );

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

  router.get('/operations/gasless-relayer/dead-letters', async (req, res, next) => {
    try {
      if (!options.gaslessSettlementService) {
        throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gasless execution is not configured');
      }
      const items = await options.gaslessSettlementService.listDeadLetterCommands(
        parseDeadLetterLimit(req.query.limit),
      );
      res.status(200).json(successResponse({ items, generatedAt: new Date().toISOString() }));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/operations/gasless-relayer/dead-letters/:commandId/redrive',
    requireMutationWriteAccess(),
    requireOperatorActionCapability('operations:replay'),
    replayIdempotency,
    async (req, res, next) => {
      try {
        if (!options.gaslessSettlementService) {
          throw new GatewayError(
            503,
            'UPSTREAM_UNAVAILABLE',
            'Gasless execution is not configured',
          );
        }
        if (!req.gatewayPrincipal || !req.requestContext) {
          throw new GatewayError(500, 'INTERNAL_ERROR', 'Operator request context is unavailable');
        }
        const idempotencyKey = req.header('Idempotency-Key')?.trim();
        if (!idempotencyKey) {
          throw new GatewayError(
            500,
            'INTERNAL_ERROR',
            'Operator idempotency context is unavailable',
          );
        }
        const command = await options.gaslessSettlementService.redriveDeadLetterCommand(
          parseGaslessCommandId(req.params.commandId),
          {
            route: req.route.path,
            method: req.method,
            idempotencyKey,
            principal: req.gatewayPrincipal,
            requestContext: req.requestContext,
          },
        );
        res.status(202).json(successResponse(sanitizeGaslessCommand(command)));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/operations/failed-operations', async (req, res, next) => {
    try {
      const records = await requireFailedOperationStore(options.failedOperationStore).list({
        failureState: parseFailedOperationState(req.query.failureState),
        replayEligible: parseReplayEligible(req.query.replayEligible),
      });
      res.status(200).json(
        successResponse({
          items: records.map(sanitizeFailedOperation),
          generatedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/operations/failed-operations/:failedOperationId', async (req, res, next) => {
    try {
      const failedOperationId = parseFailedOperationId(req.params.failedOperationId);
      const record = await requireFailedOperationStore(options.failedOperationStore).get(
        failedOperationId,
      );
      if (!record) {
        throw new GatewayError(404, 'NOT_FOUND', 'Failed operation not found', {
          failedOperationId,
        });
      }
      res.status(200).json(successResponse(sanitizeFailedOperation(record)));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/operations/failed-operations/:failedOperationId/replay',
    requireMutationWriteAccess(),
    requireOperatorActionCapability('operations:replay'),
    replayIdempotency,
    async (req, res, next) => {
      try {
        const failedOperationId = parseFailedOperationId(req.params.failedOperationId);
        if (!options.failedOperationReplayer) {
          throw new GatewayError(
            503,
            'UPSTREAM_UNAVAILABLE',
            'Failed-operation replay is not configured',
          );
        }
        await requireReplayableFailedOperation(options.failedOperationStore, failedOperationId);
        const replayed = await options.failedOperationReplayer.replay(failedOperationId);
        res.status(202).json(successResponse(sanitizeFailedOperation(replayed)));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
