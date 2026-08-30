/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NextFunction, Request, Response } from 'express';
import { GatewayError } from '../errors';
import { buildRequestFingerprint, IdempotencyStore } from '../core/idempotencyStore';
import { Logger } from '../logging/logger';
import { errorResponse } from '../responses';
import { resolveGatewayActorKey } from './auth';
import {
  financialOutcomeResponse,
  gaslessCommandResponse,
  hasTerminalFinancialFailure,
  hasUnresolvedFinancialOutcome,
  isTerminalFinancialOutcome,
} from './idempotencyRecoveryResponses';

export interface IdempotencyRequestState {
  idempotencyKey: string;
  actorId: string;
  endpoint: string;
  requestFingerprint: string;
}

interface IdempotencyResponseFinalizer {
  finalized: boolean;
  complete(status: number, body: unknown): Promise<void>;
  release(): Promise<void>;
  hold(): void;
}

function responseFinalizer(res: Response): IdempotencyResponseFinalizer | null {
  const value = res.locals.idempotencyResponseFinalizer as unknown;
  if (!value || typeof value !== 'object') return null;
  return value as IdempotencyResponseFinalizer;
}

export async function persistIdempotentResponse(
  res: Response,
  status: number,
  body: unknown,
): Promise<void> {
  const finalizer = responseFinalizer(res);
  if (!finalizer) return;
  res.status(status);
  res.type('application/json');
  await finalizer.complete(status, body);
}

export async function persistIdempotentError(
  res: Response,
  status: number,
  body: unknown,
): Promise<void> {
  const finalizer = responseFinalizer(res);
  if (!finalizer) return;
  if (hasUnresolvedFinancialOutcome(body)) {
    finalizer.hold();
    return;
  }
  if (hasTerminalFinancialFailure(body)) {
    await persistIdempotentResponse(res, status, body);
    return;
  }
  if (status >= 500) {
    await finalizer.release();
    return;
  }
  await persistIdempotentResponse(res, status, body);
}

function resolveActorId(req: Request): string {
  const principal = req.gatewayPrincipal;
  if (principal) {
    return resolveGatewayActorKey(principal.session);
  }

  if (req.serviceAuth?.apiKeyId) {
    return `service:${req.serviceAuth.apiKeyId}`;
  }

  throw new GatewayError(
    500,
    'INTERNAL_ERROR',
    'Idempotency scope could not resolve actor context',
  );
}

function resolveEndpoint(req: Request): string {
  const routePath = typeof req.route?.path === 'string' ? req.route.path : req.path;
  return `${req.baseUrl || ''}${routePath || ''}` || req.path;
}

function normalizeBody(body: unknown): unknown {
  if (body === undefined) {
    return null;
  }

  if (Buffer.isBuffer(body)) {
    const asText = body.toString('utf8');
    try {
      return JSON.parse(asText);
    } catch {
      return asText;
    }
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  return body;
}

function replayHeaders(res: Response): Record<string, string> {
  const headerNames = ['content-type'];
  const snapshot: Record<string, string> = {};

  for (const name of headerNames) {
    const value = res.getHeader(name);
    if (typeof value === 'string') {
      snapshot[name] = value;
    }
  }

  return snapshot;
}

export function createIdempotencyMiddleware(store: IdempotencyStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey) {
      next(
        new GatewayError(
          400,
          'VALIDATION_ERROR',
          'Idempotency-Key header is required for mutation routes',
        ),
      );
      return;
    }

    const actorId = resolveActorId(req);
    const endpoint = resolveEndpoint(req);
    const requestPath = `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl || req.path;
    const requestFingerprint = buildRequestFingerprint(req.method, requestPath, req.rawBody);
    const reservation = await store.createPending({
      idempotencyKey,
      actorId,
      endpoint,
      requestMethod: req.method,
      requestPath,
      requestFingerprint,
      requestId: req.requestContext?.requestId || 'unknown',
    });

    if (!reservation.created) {
      const existing = reservation.record;
      if (
        existing.requestFingerprint !== requestFingerprint ||
        existing.requestMethod !== req.method ||
        existing.requestPath !== requestPath
      ) {
        next(
          new GatewayError(
            409,
            'CONFLICT',
            'Idempotency key is already in use for a different request',
            {
              idempotencyKey,
            },
          ),
        );
        return;
      }

      if (existing.completedAt && existing.responseStatus !== null) {
        await store.markReplay({ actorId, endpoint, idempotencyKey });
        res.setHeader('x-idempotent-replay', 'true');
        if (existing.responseHeaders['content-type']) {
          res.setHeader('content-type', existing.responseHeaders['content-type']);
        }
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }

      const financialOutcome = await store.getFinancialOutcome(existing.requestId);
      if (financialOutcome) {
        const scope = { actorId, endpoint, idempotencyKey };
        const replay = financialOutcomeResponse(req, financialOutcome);
        if (isTerminalFinancialOutcome(financialOutcome)) {
          await store.complete(
            scope,
            {
              responseStatus: replay.statusCode,
              responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
              responseBody: replay.body,
            },
            existing.requestId,
          );
        }
        await store.markReplay(scope);
        res.setHeader('x-idempotent-replay', 'true');
        res.setHeader('x-financial-outcome-recovery', 'true');
        res.status(replay.statusCode).json(replay.body);
        return;
      }

      const gaslessCommand = await store.getGaslessCommand(existing.requestId);
      if (gaslessCommand) {
        const scope = { actorId, endpoint, idempotencyKey };
        const replay = gaslessCommandResponse(req, gaslessCommand);
        if (replay.terminal) {
          await store.complete(
            scope,
            {
              responseStatus: replay.statusCode,
              responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
              responseBody: replay.body,
            },
            existing.requestId,
          );
        }
        await store.markReplay(scope);
        res.setHeader('x-idempotent-replay', 'true');
        res.setHeader('x-durable-command-recovery', 'true');
        res.status(replay.statusCode).json(replay.body);
        return;
      }

      next(
        new GatewayError(
          409,
          'CONFLICT',
          'A request with this idempotency key is already in progress',
          {
            idempotencyKey,
          },
        ),
      );
      return;
    }

    req.idempotencyState = {
      idempotencyKey,
      actorId,
      endpoint,
      requestFingerprint,
    };

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let responseBody: unknown = null;
    let responseSendStarted = false;
    let durableSendInProgress = false;
    const scope = { actorId, endpoint, idempotencyKey };
    const leaseOwnerRequestId = reservation.record.requestId;
    let leaseRenewalRunning = false;
    const leaseRenewalTimer = setInterval(
      () => {
        if (leaseRenewalRunning) return;
        leaseRenewalRunning = true;
        void store
          .renewLease(scope, leaseOwnerRequestId)
          .then((renewed) => {
            if (!renewed) {
              Logger.error('Idempotency lease ownership was lost before response completion', {
                requestId: leaseOwnerRequestId,
                endpoint,
              });
            }
          })
          .catch((error) => {
            Logger.error('Idempotency lease renewal failed', {
              requestId: leaseOwnerRequestId,
              endpoint,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            leaseRenewalRunning = false;
          });
      },
      Math.max(1_000, Math.floor(store.leaseDurationMs / 3)),
    );
    leaseRenewalTimer.unref();
    const stopLeaseRenewal = (): void => clearInterval(leaseRenewalTimer);
    res.once('finish', stopLeaseRenewal);
    res.once('close', stopLeaseRenewal);
    const finalizer: IdempotencyResponseFinalizer = {
      finalized: false,
      async complete(status, body) {
        await store.complete(
          scope,
          {
            responseStatus: status,
            responseHeaders: replayHeaders(res),
            responseBody: body,
          },
          leaseOwnerRequestId,
        );
        this.finalized = true;
      },
      async release() {
        await store.releasePending(scope, leaseOwnerRequestId);
        this.finalized = true;
      },
      hold() {
        this.finalized = true;
      },
    };
    res.locals.idempotencyResponseFinalizer = finalizer;

    const finalizeBeforeSend = async (status: number, body: unknown): Promise<void> => {
      if (finalizer.finalized) return;
      if (status >= 400) {
        await persistIdempotentError(res, status, body);
        return;
      }
      await persistIdempotentResponse(res, status, body);
    };

    const sendAfterDurableFinalization = async (
      kind: 'json' | 'send',
      body: unknown,
    ): Promise<void> => {
      responseBody = kind === 'json' ? body : normalizeBody(body);
      try {
        await finalizeBeforeSend(res.statusCode, responseBody);
      } catch (error) {
        Logger.error('Failed to persist idempotency state before sending response', {
          requestId: leaseOwnerRequestId,
          endpoint,
          error: error instanceof Error ? error.message : String(error),
        });
        finalizer.hold();
        res.status(503);
        responseBody = errorResponse(
          req.requestContext,
          'UPSTREAM_UNAVAILABLE',
          'Durable request state is unavailable',
        );
        kind = 'json';
        body = responseBody;
      }

      durableSendInProgress = true;
      if (kind === 'json') originalJson(body);
      else originalSend(body);
    };

    res.json = ((body: unknown) => {
      if (durableSendInProgress) return originalJson(body);
      if (responseSendStarted) return res;
      responseSendStarted = true;
      void sendAfterDurableFinalization('json', body);
      return res;
    }) as Response['json'];

    res.send = ((body: unknown) => {
      if (durableSendInProgress) return originalSend(body);
      if (responseSendStarted) return res;
      responseSendStarted = true;
      void sendAfterDurableFinalization('send', body);
      return res;
    }) as Response['send'];

    res.on('finish', () => {
      if (finalizer.finalized) return;
      if (res.statusCode >= 500) {
        if (hasUnresolvedFinancialOutcome(responseBody)) return;
        void store.releasePending(scope, leaseOwnerRequestId);
        return;
      }

      void store.complete(
        scope,
        {
          responseStatus: res.statusCode,
          responseHeaders: replayHeaders(res),
          responseBody,
        },
        leaseOwnerRequestId,
      );
    });

    next();
  };
}
