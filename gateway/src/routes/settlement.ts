/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { GatewayError } from '../errors';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { successResponse } from '../responses';
import { IdempotencyStore } from '../core/idempotencyStore';
import { GaslessSettlementExecutionService } from '../core/gaslessSettlementExecutionService';
import type { GaslessUserAction } from '../core/gaslessSettlementExecutionService';
import { createServiceAuthMiddleware } from '../core/serviceAuth';
import { SettlementService } from '../core/settlementService';
import {
  SettlementStore,
  SETTLEMENT_EVENT_TYPES,
  SETTLEMENT_EXECUTION_STATUSES,
  SETTLEMENT_RECONCILIATION_STATUSES,
} from '../core/settlementStore';

export interface SettlementRouterOptions {
  config: GatewayConfig;
  settlementService: SettlementService;
  settlementStore: SettlementStore;
  gaslessSettlementService?: GaslessSettlementExecutionService | null;
  nonceStore: { consume(apiKey: string, nonce: string, ttlSeconds: number): Promise<boolean> };
  idempotencyStore: IdempotencyStore;
  lookupServiceApiKey: (
    apiKey: string,
  ) => { id: string; secret: string; active: boolean } | undefined;
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

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return requireString(value, field);
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a number`);
  }

  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be an integer`);
  }

  return value;
}

function requireEventType(value: unknown): (typeof SETTLEMENT_EVENT_TYPES)[number] {
  const eventType = requireString(value, 'eventType');
  if (!SETTLEMENT_EVENT_TYPES.includes(eventType as (typeof SETTLEMENT_EVENT_TYPES)[number])) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'eventType is not supported', {
      allowed: SETTLEMENT_EVENT_TYPES,
    });
  }

  return eventType as (typeof SETTLEMENT_EVENT_TYPES)[number];
}

function requireExecutionStatus(value: unknown): (typeof SETTLEMENT_EXECUTION_STATUSES)[number] {
  const executionStatus = requireString(value, 'executionStatus');
  if (
    !SETTLEMENT_EXECUTION_STATUSES.includes(
      executionStatus as (typeof SETTLEMENT_EXECUTION_STATUSES)[number],
    )
  ) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'executionStatus is not supported', {
      allowed: SETTLEMENT_EXECUTION_STATUSES,
    });
  }

  return executionStatus as (typeof SETTLEMENT_EXECUTION_STATUSES)[number];
}

function requireReconciliationStatus(
  value: unknown,
): (typeof SETTLEMENT_RECONCILIATION_STATUSES)[number] {
  const reconciliationStatus = requireString(value, 'reconciliationStatus');
  if (
    !SETTLEMENT_RECONCILIATION_STATUSES.includes(
      reconciliationStatus as (typeof SETTLEMENT_RECONCILIATION_STATUSES)[number],
    )
  ) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'reconciliationStatus is not supported', {
      allowed: SETTLEMENT_RECONCILIATION_STATUSES,
    });
  }

  return reconciliationStatus as (typeof SETTLEMENT_RECONCILIATION_STATUSES)[number];
}

function optionalMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  return requireObject(value, 'metadata');
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

function getRequestId(req: Request): string {
  return req.requestContext?.requestId || 'unknown';
}

function getServiceApiKeyId(req: Request): string | null {
  return req.serviceAuth?.apiKeyId ?? null;
}

async function handleRequest(
  handler: () => Promise<unknown>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = await handler();
    res.status(202).json(successResponse(payload));
  } catch (error) {
    next(error);
  }
}

export function createSettlementRouter(options: SettlementRouterOptions): Router {
  const router = Router();
  const idempotency = createIdempotencyMiddleware(options.idempotencyStore);
  const serviceAuth = createServiceAuthMiddleware({
    enabled: options.config.settlementIngressEnabled,
    maxSkewSeconds: options.config.settlementServiceAuthMaxSkewSeconds,
    nonceTtlSeconds: options.config.settlementServiceAuthNonceTtlSeconds,
    sharedSecret: options.config.settlementServiceAuthSharedSecret,
    lookupApiKey: options.lookupServiceApiKey,
    consumeNonce: options.nonceStore.consume.bind(options.nonceStore),
  });

  router.use('/settlement', (req, _res, next) => {
    if (!options.config.settlementIngressEnabled) {
      next(
        new GatewayError(403, 'FORBIDDEN', 'Settlement ingress is disabled', {
          reason: 'settlement_ingress_disabled',
        }),
      );
      return;
    }

    next();
  });

  router.use('/settlement', serviceAuth);

  router.post('/settlement/handoffs', idempotency, (req, res, next) =>
    handleRequest(
      async () => {
        const body = requireObject(req.body, 'body');
        rejectUnexpectedFields(
          body,
          [
            'platformId',
            'platformHandoffId',
            'tradeId',
            'phase',
            'settlementChannel',
            'displayCurrency',
            'displayAmount',
            'assetSymbol',
            'assetAmount',
            'ricardianHash',
            'externalReference',
            'metadata',
          ],
          'body',
        );
        const handoff = await options.settlementService.createHandoff({
          platformId: requireString(body.platformId, 'platformId'),
          platformHandoffId: requireString(body.platformHandoffId, 'platformHandoffId'),
          tradeId: requireString(body.tradeId, 'tradeId'),
          phase: requireString(body.phase, 'phase'),
          settlementChannel: requireString(body.settlementChannel, 'settlementChannel'),
          displayCurrency: requireString(body.displayCurrency, 'displayCurrency'),
          displayAmount: requireNumber(body.displayAmount, 'displayAmount'),
          assetSymbol: optionalString(body.assetSymbol, 'assetSymbol'),
          assetAmount:
            body.assetAmount === undefined || body.assetAmount === null
              ? null
              : requireNumber(body.assetAmount, 'assetAmount'),
          ricardianHash: optionalString(body.ricardianHash, 'ricardianHash'),
          externalReference: optionalString(body.externalReference, 'externalReference'),
          metadata: optionalMetadata(body.metadata),
          requestId: getRequestId(req),
          sourceApiKeyId: getServiceApiKeyId(req),
        });

        return handoff;
      },
      res,
      next,
    ),
  );

  router.post('/settlement/handoffs/:handoffId/execution-events', idempotency, (req, res, next) =>
    handleRequest(
      async () => {
        const handoffId = requireString(req.params.handoffId, 'handoffId');
        const body = requireObject(req.body, 'body');
        rejectUnexpectedFields(
          body,
          [
            'eventType',
            'executionStatus',
            'reconciliationStatus',
            'providerStatus',
            'txHash',
            'detail',
            'metadata',
            'observedAt',
          ],
          'body',
        );
        const executionStatus = requireExecutionStatus(body.executionStatus);
        const txHash = optionalString(body.txHash, 'txHash');
        const result = await options.settlementService.recordExecutionEvent({
          handoffId,
          eventType: requireEventType(body.eventType),
          executionStatus,
          reconciliationStatus: requireReconciliationStatus(body.reconciliationStatus),
          providerStatus: optionalString(body.providerStatus, 'providerStatus'),
          txHash,
          detail: optionalString(body.detail, 'detail'),
          metadata: optionalMetadata(body.metadata),
          observedAt: requireString(body.observedAt, 'observedAt'),
          requestId: getRequestId(req),
          sourceApiKeyId: getServiceApiKeyId(req),
        });

        return {
          handoff: result.handoff,
          event: result.event,
          callbackDelivery: result.callbackDelivery,
        };
      },
      res,
      next,
    ),
  );

  router.post('/settlement/gasless-executions/create-trade', idempotency, (req, res, next) =>
    handleRequest(
      async () => {
        if (!options.config.gaslessExecutionEnabled || !options.gaslessSettlementService) {
          throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gasless execution is disabled', {
            reason: 'gasless_execution_disabled',
          });
        }

        const body = requireObject(req.body, 'body');
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

        return options.gaslessSettlementService.executeCreateTrade({
          action: requireString(body.action, 'action') as 'create_trade',
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
            validBefore: requireString(
              usdcAuthorization.validBefore,
              'usdcAuthorization.validBefore',
            ),
            nonce: requireString(usdcAuthorization.nonce, 'usdcAuthorization.nonce'),
            v: requireInteger(usdcAuthorization.v, 'usdcAuthorization.v'),
            r: requireString(usdcAuthorization.r, 'usdcAuthorization.r'),
            s: requireString(usdcAuthorization.s, 'usdcAuthorization.s'),
          },
          requestId: getRequestId(req),
          sourceApiKeyId: getServiceApiKeyId(req),
        });
      },
      res,
      next,
    ),
  );

  router.post('/settlement/gasless-executions/user-action', idempotency, (req, res, next) =>
    handleRequest(
      async () => {
        if (!options.config.gaslessExecutionEnabled || !options.gaslessSettlementService) {
          throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', 'Gasless execution is disabled', {
            reason: 'gasless_execution_disabled',
          });
        }

        const body = requireObject(req.body, 'body');
        rejectUnexpectedFields(
          body,
          [
            'action',
            'handoffId',
            'chainId',
            'contractAddress',
            'expiresAt',
            'payloadHash',
            'userAddress',
            'tradeId',
            'userAuthorization',
          ],
          'body',
        );
        const userAuthorization = requireObject(body.userAuthorization, 'userAuthorization');
        rejectUnexpectedFields(
          userAuthorization,
          ['nonce', 'deadline', 'signature'],
          'userAuthorization',
        );

        return options.gaslessSettlementService.executeUserAction({
          action: requireString(body.action, 'action') as GaslessUserAction,
          handoffId: requireString(body.handoffId, 'handoffId'),
          chainId: requireInteger(body.chainId, 'chainId'),
          contractAddress: requireString(body.contractAddress, 'contractAddress'),
          expiresAt: requireString(body.expiresAt, 'expiresAt'),
          payloadHash: requireString(body.payloadHash, 'payloadHash'),
          userAddress: requireString(body.userAddress, 'userAddress'),
          tradeId: requireString(body.tradeId, 'tradeId'),
          userAuthorization: {
            nonce: requireString(userAuthorization.nonce, 'userAuthorization.nonce'),
            deadline: requireString(userAuthorization.deadline, 'userAuthorization.deadline'),
            signature: requireString(userAuthorization.signature, 'userAuthorization.signature'),
          },
          requestId: getRequestId(req),
          sourceApiKeyId: getServiceApiKeyId(req),
        });
      },
      res,
      next,
    ),
  );

  router.get('/settlement/handoffs/:handoffId/execution-events', async (req, res, next) => {
    try {
      const handoffId = requireString(req.params.handoffId, 'handoffId');
      const events = await options.settlementService.listExecutionEvents(handoffId);
      res.status(200).json(successResponse(events));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
