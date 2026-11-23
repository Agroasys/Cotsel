/**
 * SPDX-License-Identifier: Apache-2.0
 */
// Settlement template registry routes (Cotsel#940). Reads need operator:read.
// Every change needs write access, governance:write, a recent upstream step-up
// (Cotsel#946) and an Idempotency-Key, and its audit row commits in the same
// transaction as the change. Review and activation by the author are refused.
import { Request, Response, NextFunction, Router } from 'express';
import type { GatewayConfig } from '../config/env';
import type { AuthSessionClient } from '../core/authSessionClient';
import { appendAuditLogEntry, type AuditLogStore } from '../core/auditLogStore';
import type { IdempotencyStore } from '../core/idempotencyStore';
import {
  parseSettlementTemplate,
  parseTemplateId,
  parseTemplateVersion,
} from '../core/settlementTemplateInput';
import type {
  SettlementTemplateAudit,
  SettlementTemplateStore,
} from '../core/settlementTemplateStore';
import { GatewayError } from '../errors';
import {
  createAuthenticationMiddleware,
  requireGatewayRole,
  requireMutationWriteAccess,
  requireOperatorActionCapability,
  resolveGatewayActorKey,
} from '../middleware/auth';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { requireRecentStepUp } from '../middleware/stepUp';
import { successResponse } from '../responses';

export interface SettlementTemplateRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  templateStore: SettlementTemplateStore;
  idempotencyStore: IdempotencyStore;
  /** Receives the step-up guard's own evidence rows. */
  auditLogStore?: AuditLogStore;
}

interface ChangeContext {
  actor: string;
  audit: SettlementTemplateAudit;
}

function changeContext(req: Request): ChangeContext {
  const principal = req.gatewayPrincipal;
  if (!principal) throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
  if (!req.requestContext) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
  }
  const { requestId, correlationId } = req.requestContext;
  const actor = resolveGatewayActorKey(principal.session);
  return {
    actor,
    audit: (db, { action, record, replaced }) =>
      appendAuditLogEntry(db, {
        eventType: `gateway.settlement_template.${action}`,
        route: req.originalUrl || req.path,
        method: req.method,
        requestId,
        correlationId,
        idempotencyKey: req.idempotencyState?.idempotencyKey ?? null,
        actorId: actor,
        actorUserId: principal.session.userId,
        actorWalletAddress: principal.session.walletAddress ?? null,
        actorRole: principal.session.role,
        status: 'success',
        metadata: {
          templateId: record.templateId,
          version: record.version,
          templateHash: record.templateHash,
          status: record.status,
          ...(replaced ? { replacedVersion: replaced.version } : {}),
          ...(req.stepUpEvidence ? { stepUp: req.stepUpEvidence } : {}),
        },
      }),
  };
}

function respond(
  statusCode: number,
  operation: (req: Request) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      res.status(statusCode).json(successResponse(await operation(req)));
    } catch (error) {
      next(error);
    }
  };
}

function pathVersion(req: Request) {
  return {
    templateId: parseTemplateId(req.params.templateId),
    version: parseTemplateVersion(req.params.version),
  };
}

export function createSettlementTemplateRouter(options: SettlementTemplateRouterOptions): Router {
  const router = Router();
  const store = options.templateStore;
  const change = [
    requireMutationWriteAccess(),
    requireOperatorActionCapability('governance:write'),
    requireRecentStepUp(options.config, { auditLogStore: options.auditLogStore }),
    createIdempotencyMiddleware(options.idempotencyStore),
  ];

  router.use(
    '/settlement-templates',
    createAuthenticationMiddleware(options.authSessionClient, options.config),
  );

  router.get(
    '/settlement-templates',
    requireGatewayRole('operator:read'),
    respond(200, async (req) => {
      const templateId =
        req.query.templateId === undefined ? undefined : parseTemplateId(req.query.templateId);
      return { items: await store.list(templateId) };
    }),
  );

  router.get(
    '/settlement-templates/:templateId/versions/:version',
    requireGatewayRole('operator:read'),
    respond(200, async (req) => {
      const { templateId, version } = pathVersion(req);
      const record = await store.get(templateId, version);
      if (!record) {
        throw new GatewayError(404, 'NOT_FOUND', 'Settlement template version not found', {
          templateId,
          version,
        });
      }
      return record;
    }),
  );

  router.post(
    '/settlement-templates',
    ...change,
    respond(201, async (req) => {
      const body = req.body as Record<string, unknown> | undefined;
      const template = parseSettlementTemplate(body?.template);
      const { actor, audit } = changeContext(req);
      return store.createDraft({
        template,
        actor,
        requestId: req.requestContext?.requestId ?? 'unknown',
        audit,
      });
    }),
  );

  router.post(
    '/settlement-templates/:templateId/versions/:version/review',
    ...change,
    respond(200, (req) => store.review({ ...pathVersion(req), ...changeContext(req) })),
  );

  router.post(
    '/settlement-templates/:templateId/versions/:version/activate',
    ...change,
    respond(200, (req) => store.activate({ ...pathVersion(req), ...changeContext(req) })),
  );

  router.post(
    '/settlement-templates/:templateId/versions/:version/retire',
    ...change,
    respond(200, (req) => store.retire({ ...pathVersion(req), ...changeContext(req) })),
  );

  return router;
}
