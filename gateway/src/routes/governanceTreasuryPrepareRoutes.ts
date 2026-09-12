/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { RequestHandler, Router } from 'express';
import {
  validateAddressInput,
  validateGovernanceAuditInput,
  validateProposalId,
} from '../core/governanceMutationValidation';
import { GatewayError } from '../errors';
import {
  getMutationContext,
  getPathParam,
  nowSeconds,
  prepareAndRespond,
} from './governanceMutationRouteSupport';
import type { GovernanceDirectSignRouterOptions } from './governanceDirectSignRouteTypes';

export function registerGovernanceTreasuryPrepareRoutes(
  router: Router,
  idempotency: RequestHandler,
  options: GovernanceDirectSignRouterOptions,
): void {
  router.post(
    '/governance/treasury/payout-receiver/proposals/prepare',
    idempotency,
    (req, res, next) =>
      prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        const newPayoutReceiver = validateAddressInput(
          (req.body as Record<string, unknown>)?.newPayoutReceiver,
          'newPayoutReceiver',
        );
        if (newPayoutReceiver.toLowerCase() === status.treasuryPayoutAddress.toLowerCase()) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'New payout receiver matches the current treasury payout receiver',
          );
        }

        return options.mutationService.prepareAction({
          category: 'treasury_payout_receiver_update',
          contractMethod: 'proposeTreasuryPayoutAddressUpdate',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          signerWallet,
          requestContext,
          signerBinding,
          idempotencyKey,
          targetAddress: newPayoutReceiver,
        });
      }),
  );

  router.post(
    '/governance/treasury/payout-receiver/proposals/:proposalId/approve/prepare',
    idempotency,
    (req, res, next) =>
      prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal =
          await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
        if (!proposal) {
          throw new GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', {
            proposalId,
          });
        }
        if (proposal.executed || proposal.cancelled || proposal.expired) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Treasury payout receiver proposal is no longer approvable',
            { proposalId },
          );
        }

        if (
          await options.governanceReader.hasApprovedTreasuryPayoutReceiverProposal(
            proposalId,
            signerWallet,
          )
        ) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Caller has already approved this treasury payout receiver proposal',
            { proposalId },
          );
        }

        return options.mutationService.prepareAction({
          category: 'treasury_payout_receiver_update',
          contractMethod: 'approveTreasuryPayoutAddressUpdate',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          signerWallet,
          requestContext,
          signerBinding,
          idempotencyKey,
          proposalId,
          targetAddress: proposal.targetAddress,
        });
      }),
  );

  router.post(
    '/governance/treasury/payout-receiver/proposals/:proposalId/execute/prepare',
    idempotency,
    (req, res, next) =>
      prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal =
          await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
        if (!proposal) {
          throw new GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', {
            proposalId,
          });
        }
        if (proposal.executed || proposal.cancelled || proposal.expired) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Treasury payout receiver proposal is not executable',
            { proposalId },
          );
        }

        const status = await options.governanceReader.getGovernanceStatus();
        if (proposal.approvalCount < status.governanceApprovalsRequired) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Treasury payout receiver proposal does not have enough approvals',
            { proposalId },
          );
        }
        if (proposal.etaSeconds > nowSeconds()) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Treasury payout receiver proposal timelock has not elapsed',
            { proposalId },
          );
        }

        return options.mutationService.prepareAction({
          category: 'treasury_payout_receiver_update',
          contractMethod: 'executeTreasuryPayoutAddressUpdate',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          signerWallet,
          requestContext,
          signerBinding,
          idempotencyKey,
          proposalId,
          targetAddress: proposal.targetAddress,
        });
      }),
  );

  router.post(
    '/governance/treasury/payout-receiver/proposals/:proposalId/cancel-expired/prepare',
    idempotency,
    (req, res, next) =>
      prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal =
          await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
        if (!proposal) {
          throw new GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', {
            proposalId,
          });
        }
        if (proposal.executed || proposal.cancelled || !proposal.expired) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Treasury payout receiver proposal is not cancellable as expired',
            { proposalId },
          );
        }

        return options.mutationService.prepareAction({
          category: 'treasury_payout_receiver_update',
          contractMethod: 'cancelExpiredTreasuryPayoutAddressUpdateProposal',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          signerWallet,
          requestContext,
          signerBinding,
          idempotencyKey,
          proposalId,
          targetAddress: proposal.targetAddress,
        });
      }),
  );
}
