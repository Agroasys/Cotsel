/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Request, Response, Router } from 'express';
import { GatewayConfig } from '../config/env';
import { AuthSessionClient } from '../core/authSessionClient';
import {
  GovernanceMutationAccepted,
  GovernanceMutationService,
  validateAddressInput,
  validateGovernanceAuditInput,
  validateProposalId,
} from '../core/governanceMutationService';
import { GovernanceMutationPreflightReader } from '../core/governanceStatusService';
import { IdempotencyStore } from '../core/idempotencyStore';
import { createAuthenticationMiddleware, requireMutationWriteAccess } from '../middleware/auth';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { GatewayError } from '../errors';
import { successResponse } from '../responses';
import type { GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';

export interface GovernanceMutationRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  governanceReader: GovernanceMutationPreflightReader;
  mutationService: GovernanceMutationService;
  idempotencyStore: IdempotencyStore;
}

interface MutationContext {
  principal: GatewayPrincipal;
  requestContext: RequestContext;
  idempotencyKey: string;
}

type MutationRequest = Request<
  Record<string, string | string[]>,
  unknown,
  Record<string, unknown>
>;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
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
    idempotencyKey: req.idempotencyState.idempotencyKey,
  };
}

function getPathParam(value: string | string[] | undefined, field: string): string | undefined {
  if (Array.isArray(value)) {
    throw new GatewayError(400, 'VALIDATION_ERROR', `Path parameter ${field} must be a string`);
  }

  return value;
}

async function queueAndRespond(
  req: MutationRequest,
  res: Response,
  next: NextFunction,
  actionFactory: () => Promise<GovernanceMutationAccepted>,
): Promise<void> {
  try {
    const accepted = await actionFactory();
    res.status(202).json(successResponse(accepted));
  } catch (error) {
    next(error);
  }
}

export function createGovernanceMutationRouter(options: GovernanceMutationRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);
  const idempotency = createIdempotencyMiddleware(options.idempotencyStore);

  router.use(authenticate, requireMutationWriteAccess());

  router.post('/governance/pause', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const status = await options.governanceReader.getGovernanceStatus();
    if (status.paused) {
      throw new GatewayError(409, 'CONFLICT', 'Protocol is already paused');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'pause',
      contractMethod: 'pause',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
    });
  }));

  router.post('/governance/unpause/proposal', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const status = await options.governanceReader.getGovernanceStatus();
    if (!status.paused) {
      throw new GatewayError(409, 'CONFLICT', 'Protocol must be paused before creating an unpause proposal');
    }
    if (!status.oracleActive) {
      throw new GatewayError(409, 'CONFLICT', 'Oracle must be active before creating an unpause proposal');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'unpause',
      contractMethod: 'proposeUnpause',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
    });
  }));

  router.post('/governance/unpause/proposal/approve', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const proposal = await options.governanceReader.getUnpauseProposalState();
    if (!proposal.hasActiveProposal) {
      throw new GatewayError(409, 'CONFLICT', 'No active unpause proposal is available to approve');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    if (await options.governanceReader.hasApprovedUnpause(principal.session.walletAddress)) {
      throw new GatewayError(409, 'CONFLICT', 'Caller has already approved the active unpause proposal');
    }

    return options.mutationService.queueAction({
      category: 'unpause',
      contractMethod: 'approveUnpause',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
    });
  }));

  router.post('/governance/unpause/proposal/cancel', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const proposal = await options.governanceReader.getUnpauseProposalState();
    if (!proposal.hasActiveProposal) {
      throw new GatewayError(409, 'CONFLICT', 'No active unpause proposal is available to cancel');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'unpause',
      contractMethod: 'cancelUnpauseProposal',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
    });
  }));

  router.post('/governance/claims/pause', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const status = await options.governanceReader.getGovernanceStatus();
    if (status.claimsPaused) {
      throw new GatewayError(409, 'CONFLICT', 'Claims are already paused');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'claims_pause',
      contractMethod: 'pauseClaims',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
    });
  }));

  router.post('/governance/claims/unpause', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const status = await options.governanceReader.getGovernanceStatus();
    if (!status.claimsPaused) {
      throw new GatewayError(409, 'CONFLICT', 'Claims are not currently paused');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'claims_unpause',
      contractMethod: 'unpauseClaims',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
    });
  }));

  router.post('/governance/treasury/sweep', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const status = await options.governanceReader.getGovernanceStatus();
    if (status.claimsPaused) {
      throw new GatewayError(409, 'CONFLICT', 'Treasury sweep is unavailable while claims are paused');
    }

    const claimableBalance = await options.governanceReader.getTreasuryClaimableBalance();
    if (claimableBalance <= 0n) {
      throw new GatewayError(409, 'CONFLICT', 'Treasury claimable balance is zero');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'treasury_sweep',
      contractMethod: 'claimTreasury',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
    });
  }));

  router.post('/governance/treasury/payout-receiver/proposals', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const status = await options.governanceReader.getGovernanceStatus();
    const newPayoutReceiver = validateAddressInput((req.body as Record<string, unknown>)?.newPayoutReceiver, 'newPayoutReceiver');
    if (newPayoutReceiver.toLowerCase() === status.treasuryPayoutAddress.toLowerCase()) {
      throw new GatewayError(409, 'CONFLICT', 'New payout receiver matches the current treasury payout receiver');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'treasury_payout_receiver_update',
      contractMethod: 'proposeTreasuryPayoutAddressUpdate',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      targetAddress: newPayoutReceiver,
    });
  }));

  router.post('/governance/treasury/payout-receiver/proposals/:proposalId/approve', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
    const proposal = await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
    if (!proposal) {
      throw new GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', { proposalId });
    }
    if (proposal.executed || proposal.cancelled || proposal.expired) {
      throw new GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal is no longer approvable', { proposalId });
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    if (await options.governanceReader.hasApprovedTreasuryPayoutReceiverProposal(proposalId, principal.session.walletAddress)) {
      throw new GatewayError(409, 'CONFLICT', 'Caller has already approved this treasury payout receiver proposal', { proposalId });
    }

    return options.mutationService.queueAction({
      category: 'treasury_payout_receiver_update',
      contractMethod: 'approveTreasuryPayoutAddressUpdate',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      proposalId,
      targetAddress: proposal.targetAddress,
    });
  }));

  router.post('/governance/treasury/payout-receiver/proposals/:proposalId/execute', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
    const proposal = await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
    if (!proposal) {
      throw new GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', { proposalId });
    }
    if (proposal.executed || proposal.cancelled || proposal.expired) {
      throw new GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal is not executable', { proposalId });
    }

    const status = await options.governanceReader.getGovernanceStatus();
    if (proposal.approvalCount < status.governanceApprovalsRequired) {
      throw new GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal does not have enough approvals', { proposalId });
    }
    if (proposal.etaSeconds > nowSeconds()) {
      throw new GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal timelock has not elapsed', { proposalId });
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'treasury_payout_receiver_update',
      contractMethod: 'executeTreasuryPayoutAddressUpdate',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      proposalId,
      targetAddress: proposal.targetAddress,
    });
  }));

  router.post('/governance/treasury/payout-receiver/proposals/:proposalId/cancel-expired', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
    const proposal = await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
    if (!proposal) {
      throw new GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', { proposalId });
    }
    if (proposal.executed || proposal.cancelled || !proposal.expired) {
      throw new GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal is not cancellable as expired', { proposalId });
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'treasury_payout_receiver_update',
      contractMethod: 'cancelExpiredTreasuryPayoutAddressUpdateProposal',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      proposalId,
      targetAddress: proposal.targetAddress,
    });
  }));

  router.post('/governance/oracle/disable-emergency', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const status = await options.governanceReader.getGovernanceStatus();
    if (!status.oracleActive) {
      throw new GatewayError(409, 'CONFLICT', 'Oracle is already disabled');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'oracle_disable_emergency',
      contractMethod: 'disableOracleEmergency',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      targetAddress: status.oracleAddress,
    });
  }));

  router.post('/governance/oracle/proposals', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const status = await options.governanceReader.getGovernanceStatus();
    const newOracleAddress = validateAddressInput((req.body as Record<string, unknown>)?.newOracleAddress, 'newOracleAddress');
    if (newOracleAddress.toLowerCase() === status.oracleAddress.toLowerCase()) {
      throw new GatewayError(409, 'CONFLICT', 'New oracle address matches the current oracle address');
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'oracle_update',
      contractMethod: 'proposeOracleUpdate',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      targetAddress: newOracleAddress,
    });
  }));

  router.post('/governance/oracle/proposals/:proposalId/approve', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
    const proposal = await options.governanceReader.getOracleProposalState(proposalId);
    if (!proposal) {
      throw new GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', { proposalId });
    }
    if (proposal.executed || proposal.cancelled || proposal.expired) {
      throw new GatewayError(409, 'CONFLICT', 'Oracle update proposal is no longer approvable', { proposalId });
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    if (await options.governanceReader.hasApprovedOracleProposal(proposalId, principal.session.walletAddress)) {
      throw new GatewayError(409, 'CONFLICT', 'Caller has already approved this oracle update proposal', { proposalId });
    }

    return options.mutationService.queueAction({
      category: 'oracle_update',
      contractMethod: 'approveOracleUpdate',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      proposalId,
      targetAddress: proposal.targetAddress,
    });
  }));

  router.post('/governance/oracle/proposals/:proposalId/execute', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
    const proposal = await options.governanceReader.getOracleProposalState(proposalId);
    if (!proposal) {
      throw new GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', { proposalId });
    }
    if (proposal.executed || proposal.cancelled || proposal.expired) {
      throw new GatewayError(409, 'CONFLICT', 'Oracle update proposal is not executable', { proposalId });
    }

    const status = await options.governanceReader.getGovernanceStatus();
    if (proposal.approvalCount < status.governanceApprovalsRequired) {
      throw new GatewayError(409, 'CONFLICT', 'Oracle update proposal does not have enough approvals', { proposalId });
    }
    if (proposal.etaSeconds > nowSeconds()) {
      throw new GatewayError(409, 'CONFLICT', 'Oracle update proposal timelock has not elapsed', { proposalId });
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'oracle_update',
      contractMethod: 'executeOracleUpdate',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      proposalId,
      targetAddress: proposal.targetAddress,
    });
  }));

  router.post('/governance/oracle/proposals/:proposalId/cancel-expired', idempotency, (req, res, next) => queueAndRespond(req, res, next, async () => {
    const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
    const proposal = await options.governanceReader.getOracleProposalState(proposalId);
    if (!proposal) {
      throw new GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', { proposalId });
    }
    if (proposal.executed || proposal.cancelled || !proposal.expired) {
      throw new GatewayError(409, 'CONFLICT', 'Oracle update proposal is not cancellable as expired', { proposalId });
    }

    const { principal, requestContext, idempotencyKey } = getMutationContext(req);
    return options.mutationService.queueAction({
      category: 'oracle_update',
      contractMethod: 'cancelExpiredOracleUpdateProposal',
      routePath: req.originalUrl || req.path,
      audit: validateGovernanceAuditInput(req.body),
      principal,
      requestContext,
      idempotencyKey,
      proposalId,
      targetAddress: proposal.targetAddress,
    });
  }));

  return router;
}
