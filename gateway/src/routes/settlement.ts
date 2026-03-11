/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { GatewayError } from '../errors';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { successResponse } from '../responses';
import { IdempotencyStore } from '../core/idempotencyStore';
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
  nonceStore: { consume(apiKey: string, nonce: string, ttlSeconds: number): Promise<boolean> };
  idempotencyStore: IdempotencyStore;
  lookupServiceApiKey: (apiKey: string) => { id: string; secret: string; active: boolean } | undefined;
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

function requireEventType(value: unknown): typeof SETTLEMENT_EVENT_TYPES[number] {
  const eventType = requireString(value, 'eventType');
  if (!SETTLEMENT_EVENT_TYPES.includes(eventType as typeof SETTLEMENT_EVENT_TYPES[number])) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'eventType is not supported', {
      allowed: SETTLEMENT_EVENT_TYPES,
    });
  }

  return eventType as typeof SETTLEMENT_EVENT_TYPES[number];
}

function requireExecutionStatus(value: unknown): typeof SETTLEMENT_EXECUTION_STATUSES[number] {
  const executionStatus = requireString(value, 'executionStatus');
  if (!SETTLEMENT_EXECUTION_STATUSES.includes(executionStatus as typeof SETTLEMENT_EXECUTION_STATUSES[number])) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'executionStatus is not supported', {
      allowed: SETTLEMENT_EXECUTION_STATUSES,
    });
  }

  return executionStatus as typeof SETTLEMENT_EXECUTION_STATUSES[number];
}

function requireReconciliationStatus(value: unknown): typeof SETTLEMENT_RECONCILIATION_STATUSES[number] {
  const reconciliationStatus = requireString(value, 'reconciliationStatus');
  if (!SETTLEMENT_RECONCILIATION_STATUSES.includes(reconciliationStatus as typeof SETTLEMENT_RECONCILIATION_STATUSES[number])) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'reconciliationStatus is not supported', {
      allowed: SETTLEMENT_RECONCILIATION_STATUSES,
    });
  }

  return reconciliationStatus as typeof SETTLEMENT_RECONCILIATION_STATUSES[number];
}

function optionalMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  return requireObject(value, 'metadata');
}

function getRequestId(req: Request): string {
  return req.requestContext?.requestId || 'unknown';
}

function getServiceApiKeyId(req: Request): string | null {
  return req.serviceAuth?.apiKeyId ?? null;
}

async function handleRequest(handler: () => Promise<unknown>, res: Response, next: NextFunction): Promise<void> {
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

  router.use(serviceAuth);

  router.post('/settlement/handoffs', idempotency, (req, res, next) => handleRequest(async () => {
    const body = requireObject(req.body, 'body');
    const handoff = await options.settlementService.createHandoff({
      platformId: requireString(body.platformId, 'platformId'),
      platformHandoffId: requireString(body.platformHandoffId, 'platformHandoffId'),
      tradeId: requireString(body.tradeId, 'tradeId'),
      phase: requireString(body.phase, 'phase'),
      settlementChannel: requireString(body.settlementChannel, 'settlementChannel'),
      displayCurrency: requireString(body.displayCurrency, 'displayCurrency'),
      displayAmount: requireNumber(body.displayAmount, 'displayAmount'),
      assetSymbol: optionalString(body.assetSymbol, 'assetSymbol'),
      assetAmount: body.assetAmount === undefined || body.assetAmount === null ? null : requireNumber(body.assetAmount, 'assetAmount'),
      ricardianHash: optionalString(body.ricardianHash, 'ricardianHash'),
      externalReference: optionalString(body.externalReference, 'externalReference'),
      metadata: optionalMetadata(body.metadata),
      requestId: getRequestId(req),
      sourceApiKeyId: getServiceApiKeyId(req),
    });

    return handoff;
  }, res, next));

  router.post('/settlement/handoffs/:handoffId/execution-events', idempotency, (req, res, next) => handleRequest(async () => {
    const handoffId = requireString(req.params.handoffId, 'handoffId');
    const body = requireObject(req.body, 'body');
    const result = await options.settlementService.recordExecutionEvent({
      handoffId,
      eventType: requireEventType(body.eventType),
      executionStatus: requireExecutionStatus(body.executionStatus),
      reconciliationStatus: requireReconciliationStatus(body.reconciliationStatus),
      providerStatus: optionalString(body.providerStatus, 'providerStatus'),
      txHash: optionalString(body.txHash, 'txHash'),
      extrinsicHash: optionalString(body.extrinsicHash, 'extrinsicHash'),
      detail: optionalString(body.detail, 'detail'),
      metadata: optionalMetadata(body.metadata),
      observedAt: requireString(body.observedAt, 'observedAt'),
      requestId: getRequestId(req),
      sourceApiKeyId: getServiceApiKeyId(req),
    });

    return result;
  }, res, next));

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
