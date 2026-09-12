/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { RequestHandler, Router } from 'express';
import { validateGovernanceAuditInput } from '../core/governanceMutationValidation';
import { GatewayError } from '../errors';
import { getMutationContext, prepareAndRespond } from './governanceMutationRouteSupport';
import type { GovernanceDirectSignRouterOptions } from './governanceDirectSignRouteTypes';

export function registerGovernanceCorePrepareRoutes(
  router: Router,
  idempotency: RequestHandler,
  options: GovernanceDirectSignRouterOptions,
): void {
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
}
