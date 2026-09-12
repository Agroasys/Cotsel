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

export function registerGovernanceOraclePrepareRoutes(
  router: Router,
  idempotency: RequestHandler,
  options: GovernanceDirectSignRouterOptions,
): void {
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
}
