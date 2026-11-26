import type { RequestHandler, Router } from 'express';
import type { GovernanceDirectSignRouterOptions } from './governanceDirectSignRouteTypes';
import { getMutationContext, prepareAndRespond } from './governanceMutationRouteSupport';
import { validateGovernanceAuditInput } from '../core/governanceMutationValidation';
import { appendAuditLogEntry } from '../core/auditLogStore';
import { resolveGatewayActorKey } from '../middleware/auth';
import { successResponse } from '../responses';
import { GatewayError } from '../errors';

export function registerGovernanceFreezeRequests(
  router: Router,
  idempotency: RequestHandler,
  options: GovernanceDirectSignRouterOptions,
) {
  const configured = () => {
    if (!options.freezeReviewStore || !options.containmentEvidence)
      throw new GatewayError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'Freeze request review is not configured',
      );
    return { store: options.freezeReviewStore, evidence: options.containmentEvidence };
  };
  router.post(
    '/governance/freeze-requests/:requestId/review',
    idempotency,
    async (req, res, next) => {
      try {
        const { store, evidence } = configured();
        const context = getMutationContext(req),
          audit = validateGovernanceAuditInput(req.body);
        const request = await evidence.freezeRequest(String(req.params.requestId));
        const decision = req.body?.decision;
        if (decision !== 'approved' && decision !== 'rejected')
          throw new GatewayError(400, 'VALIDATION_ERROR', 'decision must be approved or rejected');
        const actor = resolveGatewayActorKey(context.principal.session);
        const review = await store.review({
          request,
          decision,
          actor,
          reason: audit.reason,
          ticketRef: audit.ticketRef,
          requestId: context.requestContext.requestId,
          audit: (client, record) =>
            appendAuditLogEntry(client, {
              eventType: `governance.freeze_request.${record.decision}`,
              route: req.originalUrl,
              method: 'POST',
              requestId: context.requestContext.requestId,
              correlationId: context.requestContext.correlationId,
              idempotencyKey: context.idempotencyKey,
              actorId: actor,
              actorUserId: context.principal.session.userId,
              actorRole: context.principal.session.role,
              status: record.decision,
              metadata: { freezeRequest: request, review: record, stepUp: req.stepUpEvidence },
            }),
        });
        res.status(200).json(successResponse(review));
      } catch (error) {
        next(error);
      }
    },
  );
  router.post('/governance/freeze-requests/:requestId/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options, async (signerWallet, signerBinding) => {
      const { store, evidence } = configured();
      const request = await evidence.freezeRequest(String(req.params.requestId));
      const review = await store.get(request.requestId);
      if (review?.decision !== 'approved')
        throw new GatewayError(
          409,
          'CONFLICT',
          'A recorded human approval is required before preparing this freeze',
          { reason: 'freeze_request_not_approved', requestId: request.requestId },
        );
      const context = getMutationContext(req),
        audit = validateGovernanceAuditInput(req.body);
      return options.mutationService.prepareAction({
        category: 'pause',
        contractMethod: 'pauseTrade',
        tradeId: request.tradeId,
        evidenceReference: request.requestId,
        reconciliationFreezeRequest: { request, review },
        revalidateBeforeHandoff: async () => {
          await evidence.freezeRequest(request.requestId);
        },
        routePath: req.originalUrl,
        audit,
        principal: context.principal,
        signerWallet,
        signerBinding,
        requestContext: context.requestContext,
        idempotencyKey: context.idempotencyKey,
      });
    }),
  );
}
