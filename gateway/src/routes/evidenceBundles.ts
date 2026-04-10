/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Request, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import { EvidenceBundleService } from '../core/evidenceBundleService';
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

export interface EvidenceBundleRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  evidenceBundleService: EvidenceBundleService;
  idempotencyStore: IdempotencyStore;
}

type MutationRequest = Request<Record<string, string | string[]>, unknown, Record<string, unknown>>;

interface MutationContext {
  principal: GatewayPrincipal;
  requestContext: RequestContext;
}

function parseTradeId(value: unknown): string {
  const tradeId = typeof value === 'string' ? value.trim() : '';
  if (!tradeId) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'tradeId is required');
  }

  if (tradeId.length > 128) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'tradeId must be 128 characters or fewer');
  }

  return tradeId;
}

function parseBundleId(value: unknown): string {
  const bundleId = typeof value === 'string' ? value.trim() : '';
  if (!bundleId) {
    throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter bundleId is required');
  }

  return bundleId;
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
  };
}

export function createEvidenceBundleRouter(options: EvidenceBundleRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);
  const idempotency = createIdempotencyMiddleware(options.idempotencyStore);

  router.use(authenticate);

  router.post(
    '/evidence/bundles',
    requireMutationWriteAccess(),
    idempotency,
    async (req, res, next) => {
      try {
        const { principal, requestContext } = getMutationContext(req);
        const manifest = await options.evidenceBundleService.generate({
          tradeId: parseTradeId((req.body as Record<string, unknown>)?.tradeId),
          principal,
          requestContext,
        });

        res.status(201).json(successResponse(manifest));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/evidence/bundles/:bundleId',
    requireGatewayRole('operator:read'),
    async (req, res, next) => {
      try {
        const bundleId = parseBundleId(req.params.bundleId);
        const manifest = await options.evidenceBundleService.get(bundleId);
        if (!manifest) {
          throw new GatewayError(404, 'NOT_FOUND', 'Evidence bundle not found', {
            bundleId,
          });
        }

        res.status(200).json(successResponse(manifest));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/evidence/bundles/:bundleId/download',
    requireGatewayRole('operator:read'),
    async (req, res, next) => {
      try {
        const bundleId = parseBundleId(req.params.bundleId);
        const manifest = await options.evidenceBundleService.get(bundleId);
        if (!manifest) {
          throw new GatewayError(404, 'NOT_FOUND', 'Evidence bundle not found', {
            bundleId,
          });
        }

        res
          .status(200)
          .setHeader('content-type', 'application/json; charset=utf-8')
          .setHeader(
            'content-disposition',
            `attachment; filename=\"evidence-bundle-${bundleId}.json\"`,
          )
          .json(manifest);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
