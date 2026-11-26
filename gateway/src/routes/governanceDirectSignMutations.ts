/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { RequestHandler, Router } from 'express';
import { GatewayError } from '../errors';
import { Logger } from '../logging/logger';
import { confirmAndRespond, getPathParam } from './governanceMutationRouteSupport';
import { registerGovernanceCorePrepareRoutes } from './governanceCorePrepareRoutes';
import { registerGovernanceFreezeRequests } from './governanceFreezeRequests';
import { registerGovernanceOraclePrepareRoutes } from './governanceOraclePrepareRoutes';
import { registerGovernanceTreasuryPrepareRoutes } from './governanceTreasuryPrepareRoutes';
import type { GovernanceDirectSignRouterOptions } from './governanceDirectSignRouteTypes';

export type { GovernanceDirectSignRouterOptions } from './governanceDirectSignRouteTypes';

export function registerGovernanceDirectSignRoutes(
  router: Router,
  idempotency: RequestHandler,
  options: GovernanceDirectSignRouterOptions,
): void {
  registerGovernanceCorePrepareRoutes(router, idempotency, options);
  registerGovernanceFreezeRequests(router, idempotency, options);
  registerGovernanceTreasuryPrepareRoutes(router, idempotency, options);
  registerGovernanceOraclePrepareRoutes(router, idempotency, options);

  router.post('/governance/actions/:actionId/confirm', (req, res, next) =>
    confirmAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      if (!req.gatewayPrincipal) {
        throw new GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
      }
      if (!req.requestContext) {
        throw new GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
      }

      const actionId = getPathParam(req.params.actionId, 'actionId');
      if (!actionId) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Path parameter actionId is required');
      }

      const body = req.body as Record<string, unknown>;
      if (typeof body?.txHash !== 'string' || !body.txHash) {
        throw new GatewayError(400, 'VALIDATION_ERROR', 'txHash is required');
      }

      const reconciliationEvidenceCheck = await recheckUnpauseEvidence(options, actionId);
      const confirmed = await options.mutationService.confirmBroadcast({
        reconciliationEvidenceCheck,
        actionId,
        txHash: body.txHash,
        signerWallet,
        principal: req.gatewayPrincipal,
        signerBinding,
        requestContext: req.requestContext,
      });
      return confirmed;
    }),
  );
}

/**
 * After an unpause approval is confirmed, re-check the evidence it was
 * prepared on (review R02). The transaction is already signed and broadcast,
 * so this cannot prevent it: it detects a divergence that arrived in between,
 * records it and alerts. Prevention happens at each approver's prepare.
 */
async function recheckUnpauseEvidence(
  options: GovernanceDirectSignRouterOptions,
  actionId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const action = await options.mutationService.describeAction(actionId);
    if (action?.contractMethod !== 'approveUnpause' || !options.containmentEvidence) return;
    const evidence = action.reconciliationEvidence;
    if (typeof evidence?.tradeId !== 'string' || typeof evidence.incidentRef !== 'string') return;
    const result = await options.containmentEvidence.requireRecovery({
      tradeId: evidence.tradeId,
      incidentRef: evidence.incidentRef,
    });
    return { status: 'verified', checkedAt: new Date().toISOString(), ...result };
  } catch (error) {
    Logger.error('Unpause approval confirmed after its reconciliation evidence stopped holding', {
      actionKey: actionId,
      errorCode: 'RECONCILIATION_EVIDENCE_CHANGED_AFTER_PREPARE',
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'failed',
      checkedAt: new Date().toISOString(),
      reason:
        error instanceof GatewayError
          ? (error.details?.reason ?? error.code)
          : 'reconciliation_evidence_unavailable',
    };
  }
}
