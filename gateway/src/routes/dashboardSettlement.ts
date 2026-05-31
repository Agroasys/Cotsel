/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Request, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  GaslessCreateTradeExecutionInput,
  GaslessSettlementExecutionService,
} from '../core/gaslessSettlementExecutionService';
import { IdempotencyStore } from '../core/idempotencyStore';
import { GatewayError } from '../errors';
import { createAuthenticationMiddleware, requireMutationWriteAccess } from '../middleware/auth';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { type RequestContext } from '../middleware/requestContext';
import { successResponse } from '../responses';

export interface DashboardSettlementRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  gaslessSettlementService?: GaslessSettlementExecutionService | null;
  idempotencyStore: IdempotencyStore;
}

type MutationRequest = Request<Record<string, string | string[]>, unknown, Record<string, unknown>>;

interface MutationContext {
  requestContext: RequestContext;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a non-empty string`);
  }

  return value.trim();
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be an integer`);
  }

  return value;
}

function rejectUnexpectedFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  field: string,
): void {
  const unexpectedFields = Object.keys(value).filter((key) => !allowedFields.includes(key));
  if (unexpectedFields.length > 0) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} contains unsupported fields`, {
      field,
      unsupportedFields: unexpectedFields,
    });
  }
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
    requestContext: req.requestContext,
  };
}

function parseCreateTradeExecutionRequest(
  body: Record<string, unknown>,
  context: MutationContext,
): GaslessCreateTradeExecutionInput {
  rejectUnexpectedFields(
    body,
    [
      'action',
      'handoffId',
      'chainId',
      'contractAddress',
      'expiresAt',
      'payloadHash',
      'buyerAddress',
      'supplierAddress',
      'totalAmount',
      'logisticsAmount',
      'platformFeesAmount',
      'supplierFirstTranche',
      'supplierSecondTranche',
      'ricardianHash',
      'buyerAuthorization',
      'usdcAuthorization',
    ],
    'body',
  );

  const buyerAuthorization = requireObject(body.buyerAuthorization, 'buyerAuthorization');
  rejectUnexpectedFields(
    buyerAuthorization,
    ['nonce', 'deadline', 'signature'],
    'buyerAuthorization',
  );

  const usdcAuthorization = requireObject(body.usdcAuthorization, 'usdcAuthorization');
  rejectUnexpectedFields(
    usdcAuthorization,
    ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce', 'v', 'r', 's'],
    'usdcAuthorization',
  );

  const action = requireString(body.action, 'action');
  if (action !== 'create_trade') {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'action is not supported', {
      allowed: ['create_trade'],
    });
  }

  return {
    action,
    handoffId: requireString(body.handoffId, 'handoffId'),
    chainId: requireInteger(body.chainId, 'chainId'),
    contractAddress: requireString(body.contractAddress, 'contractAddress'),
    expiresAt: requireString(body.expiresAt, 'expiresAt'),
    payloadHash: requireString(body.payloadHash, 'payloadHash'),
    buyerAddress: requireString(body.buyerAddress, 'buyerAddress'),
    supplierAddress: requireString(body.supplierAddress, 'supplierAddress'),
    totalAmount: requireString(body.totalAmount, 'totalAmount'),
    logisticsAmount: requireString(body.logisticsAmount, 'logisticsAmount'),
    platformFeesAmount: requireString(body.platformFeesAmount, 'platformFeesAmount'),
    supplierFirstTranche: requireString(body.supplierFirstTranche, 'supplierFirstTranche'),
    supplierSecondTranche: requireString(body.supplierSecondTranche, 'supplierSecondTranche'),
    ricardianHash: requireString(body.ricardianHash, 'ricardianHash'),
    buyerAuthorization: {
      nonce: requireString(buyerAuthorization.nonce, 'buyerAuthorization.nonce'),
      deadline: requireString(buyerAuthorization.deadline, 'buyerAuthorization.deadline'),
      signature: requireString(buyerAuthorization.signature, 'buyerAuthorization.signature'),
    },
    usdcAuthorization: {
      from: requireString(usdcAuthorization.from, 'usdcAuthorization.from'),
      to: requireString(usdcAuthorization.to, 'usdcAuthorization.to'),
      value: requireString(usdcAuthorization.value, 'usdcAuthorization.value'),
      validAfter: requireString(usdcAuthorization.validAfter, 'usdcAuthorization.validAfter'),
      validBefore: requireString(usdcAuthorization.validBefore, 'usdcAuthorization.validBefore'),
      nonce: requireString(usdcAuthorization.nonce, 'usdcAuthorization.nonce'),
      v: requireInteger(usdcAuthorization.v, 'usdcAuthorization.v'),
      r: requireString(usdcAuthorization.r, 'usdcAuthorization.r'),
      s: requireString(usdcAuthorization.s, 'usdcAuthorization.s'),
    },
    requestId: context.requestContext.requestId,
    sourceApiKeyId: null,
  };
}

export function createDashboardSettlementRouter(options: DashboardSettlementRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);
  const idempotency = createIdempotencyMiddleware(options.idempotencyStore);

  router.use('/dashboard-settlement', authenticate);

  router.post(
    '/dashboard-settlement/gasless-executions/create-trade',
    requireMutationWriteAccess(),
    idempotency,
    async (req: MutationRequest, res, next) => {
      try {
        if (!options.config.gaslessExecutionEnabled || !options.gaslessSettlementService) {
          throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gasless execution is disabled', {
            reason: 'gasless_execution_disabled',
          });
        }

        const context = getMutationContext(req);
        const executionRequest = parseCreateTradeExecutionRequest(
          requireObject(req.body, 'body'),
          context,
        );
        const result = await options.gaslessSettlementService.executeCreateTrade(executionRequest);

        res.status(202).json(successResponse(result));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
