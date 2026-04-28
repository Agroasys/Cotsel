/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { RequestHandler, Router } from 'express';
import type { GovernanceMutationRouterOptions } from './governanceMutations';
import {
  confirmAndRespond,
  getMutationContext,
  getPathParam,
  nowSeconds,
  prepareAndRespond,
} from './governanceMutationRouteSupport';
import {
  validateAddressInput,
  validateGovernanceAuditInput,
  validateProposalId,
} from '../core/governanceMutationService';
import { GatewayError } from '../errors';

export function registerGovernanceDirectSignRoutes(
  router: Router,
  idempotency: RequestHandler,
  options: GovernanceMutationRouterOptions,
): void {
  // Each endpoint validates pre-flight state, builds the canonical txRequest,
  // records audit intent, and returns the payload for the admin wallet to sign.
  // The admin signs and broadcasts independently, then calls /confirm.

  router.post('/governance/pause/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const status = await options.governanceReader.getGovernanceStatus();
      if (status.paused) {
        throw new GatewayError(409, 'CONFLICT', 'Protocol is already paused');
      }

      return options.mutationService.prepareAction({
        category: 'pause',
        contractMethod: 'pause',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
      });
    }),
  );

  router.post('/governance/unpause/proposal/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const status = await options.governanceReader.getGovernanceStatus();
      if (!status.paused) {
        throw new GatewayError(
          409,
          'CONFLICT',
          'Protocol must be paused before creating an unpause proposal',
        );
      }
      if (!status.oracleActive) {
        throw new GatewayError(
          409,
          'CONFLICT',
          'Oracle must be active before creating an unpause proposal',
        );
      }

      return options.mutationService.prepareAction({
        category: 'unpause',
        contractMethod: 'proposeUnpause',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
      });
    }),
  );

  router.post('/governance/unpause/proposal/approve/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const proposal = await options.governanceReader.getUnpauseProposalState();
      if (!proposal.hasActiveProposal) {
        throw new GatewayError(
          409,
          'CONFLICT',
          'No active unpause proposal is available to approve',
        );
      }

      if (await options.governanceReader.hasApprovedUnpause(signerWallet)) {
        throw new GatewayError(
          409,
          'CONFLICT',
          'Caller has already approved the active unpause proposal',
        );
      }

      return options.mutationService.prepareAction({
        category: 'unpause',
        contractMethod: 'approveUnpause',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
      });
    }),
  );

  router.post('/governance/unpause/proposal/cancel/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const proposal = await options.governanceReader.getUnpauseProposalState();
      if (!proposal.hasActiveProposal) {
        throw new GatewayError(
          409,
          'CONFLICT',
          'No active unpause proposal is available to cancel',
        );
      }

      return options.mutationService.prepareAction({
        category: 'unpause',
        contractMethod: 'cancelUnpauseProposal',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
      });
    }),
  );

  router.post('/governance/claims/pause/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const status = await options.governanceReader.getGovernanceStatus();
      if (status.claimsPaused) {
        throw new GatewayError(409, 'CONFLICT', 'Claims are already paused');
      }

      return options.mutationService.prepareAction({
        category: 'claims_pause',
        contractMethod: 'pauseClaims',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
      });
    }),
  );

  router.post('/governance/claims/unpause/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const status = await options.governanceReader.getGovernanceStatus();
      if (!status.claimsPaused) {
        throw new GatewayError(409, 'CONFLICT', 'Claims are not currently paused');
      }

      return options.mutationService.prepareAction({
        category: 'claims_unpause',
        contractMethod: 'unpauseClaims',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
      });
    }),
  );

  router.post('/governance/treasury/sweep/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const status = await options.governanceReader.getGovernanceStatus();
      if (status.claimsPaused) {
        throw new GatewayError(
          409,
          'CONFLICT',
          'Treasury sweep is unavailable while claims are paused',
        );
      }

      const claimableBalance = await options.governanceReader.getTreasuryClaimableBalance();
      if (claimableBalance <= 0n) {
        throw new GatewayError(409, 'CONFLICT', 'Treasury claimable balance is zero');
      }

      return options.mutationService.prepareAction({
        category: 'treasury_sweep',
        contractMethod: 'claimTreasury',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
      });
    }),
  );

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

  router.post('/governance/oracle/disable-emergency/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const status = await options.governanceReader.getGovernanceStatus();
      if (!status.oracleActive) {
        throw new GatewayError(409, 'CONFLICT', 'Oracle is already disabled');
      }

      return options.mutationService.prepareAction({
        category: 'oracle_disable_emergency',
        contractMethod: 'disableOracleEmergency',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
        targetAddress: status.oracleAddress,
      });
    }),
  );

  router.post('/governance/oracle/proposals/prepare', idempotency, (req, res, next) =>
    prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
      const { principal, requestContext, idempotencyKey } = getMutationContext(req);
      const audit = validateGovernanceAuditInput(req.body);
      const status = await options.governanceReader.getGovernanceStatus();
      const newOracleAddress = validateAddressInput(
        (req.body as Record<string, unknown>)?.newOracleAddress,
        'newOracleAddress',
      );
      if (newOracleAddress.toLowerCase() === status.oracleAddress.toLowerCase()) {
        throw new GatewayError(
          409,
          'CONFLICT',
          'New oracle address matches the current oracle address',
        );
      }

      return options.mutationService.prepareAction({
        category: 'oracle_update',
        contractMethod: 'proposeOracleUpdate',
        routePath: req.originalUrl || req.path,
        audit,
        principal,
        signerWallet,
        requestContext,
        signerBinding,
        idempotencyKey,
        targetAddress: newOracleAddress,
      });
    }),
  );

  router.post(
    '/governance/oracle/proposals/:proposalId/approve/prepare',
    idempotency,
    (req, res, next) =>
      prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getOracleProposalState(proposalId);
        if (!proposal) {
          throw new GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', {
            proposalId,
          });
        }
        if (proposal.executed || proposal.cancelled || proposal.expired) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Oracle update proposal is no longer approvable',
            { proposalId },
          );
        }

        if (await options.governanceReader.hasApprovedOracleProposal(proposalId, signerWallet)) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Caller has already approved this oracle update proposal',
            { proposalId },
          );
        }

        return options.mutationService.prepareAction({
          category: 'oracle_update',
          contractMethod: 'approveOracleUpdate',
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
    '/governance/oracle/proposals/:proposalId/execute/prepare',
    idempotency,
    (req, res, next) =>
      prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getOracleProposalState(proposalId);
        if (!proposal) {
          throw new GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', {
            proposalId,
          });
        }
        if (proposal.executed || proposal.cancelled || proposal.expired) {
          throw new GatewayError(409, 'CONFLICT', 'Oracle update proposal is not executable', {
            proposalId,
          });
        }

        const status = await options.governanceReader.getGovernanceStatus();
        if (proposal.approvalCount < status.governanceApprovalsRequired) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Oracle update proposal does not have enough approvals',
            { proposalId },
          );
        }
        if (proposal.etaSeconds > nowSeconds()) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Oracle update proposal timelock has not elapsed',
            { proposalId },
          );
        }

        return options.mutationService.prepareAction({
          category: 'oracle_update',
          contractMethod: 'executeOracleUpdate',
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
    '/governance/oracle/proposals/:proposalId/cancel-expired/prepare',
    idempotency,
    (req, res, next) =>
      prepareAndRespond(req, res, next, options.config, async (signerWallet, signerBinding) => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getOracleProposalState(proposalId);
        if (!proposal) {
          throw new GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', {
            proposalId,
          });
        }
        if (proposal.executed || proposal.cancelled || !proposal.expired) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Oracle update proposal is not cancellable as expired',
            { proposalId },
          );
        }

        return options.mutationService.prepareAction({
          category: 'oracle_update',
          contractMethod: 'cancelExpiredOracleUpdateProposal',
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

  // Called by the dashboard after the admin wallet signs and broadcasts the tx.
  // Accepts the txHash, transitions the action into the monitored broadcast
  // lifecycle, and records the final signer evidence for backend reconciliation.

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

      return options.mutationService.confirmBroadcast({
        actionId,
        txHash: body.txHash,
        signerWallet,
        principal: req.gatewayPrincipal,
        signerBinding,
        requestContext: req.requestContext,
      });
    }),
  );
}
