/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { NextFunction, Response, Router } from 'express';
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
import {
  createAuthenticationMiddleware,
  requireMutationWriteAccess,
  requireOperatorActionCapability,
  requireWalletBoundSession,
  resolveGatewayActorKey,
} from '../middleware/auth';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { GatewayError } from '../errors';
import { successResponse } from '../responses';
import type { GatewayPrincipal } from '../middleware/auth';
import type { RequestContext } from '../middleware/requestContext';
import {
  GatewayErrorHandlerWorkflow,
  type GovernanceReplaySpec,
} from '../core/errorHandlerWorkflow';
import { registerGovernanceDirectSignRoutes } from './governanceDirectSignMutations';
import {
  getMutationContext,
  getPathParam,
  type MutationRequest,
  nowSeconds,
  requireDirectSignGovernancePath,
} from './governanceMutationRouteSupport';

export interface GovernanceMutationRouterOptions {
  authSessionClient: AuthSessionClient;
  config: GatewayConfig;
  governanceReader: GovernanceMutationPreflightReader;
  mutationService: GovernanceMutationService;
  idempotencyStore: IdempotencyStore;
  failedOperationWorkflow?: GatewayErrorHandlerWorkflow;
}

async function queueAndRespond(
  req: MutationRequest,
  res: Response,
  next: NextFunction,
  options: GovernanceMutationRouterOptions,
  failureCapture: {
    principal: GatewayPrincipal;
    requestContext: RequestContext;
    idempotencyKey: string;
    replaySpec: GovernanceReplaySpec;
  },
  actionFactory: () => Promise<GovernanceMutationAccepted>,
): Promise<void> {
  try {
    const accepted = await actionFactory();
    res.status(202).json(successResponse(accepted));
  } catch (error) {
    if (options.failedOperationWorkflow) {
      const failedOperation = await options.failedOperationWorkflow.captureFailure({
        operationType: 'governance.queue_action',
        operationKey: `${resolveGatewayActorKey(failureCapture.principal.session)}:${req.originalUrl || req.path}:${failureCapture.idempotencyKey}`,
        targetService: 'gateway_governance_queue',
        route: req.originalUrl || req.path,
        method: req.method,
        requestContext: failureCapture.requestContext,
        requestPayload: req.body,
        idempotencyKey: failureCapture.idempotencyKey,
        principal: failureCapture.principal,
        replaySpec: failureCapture.replaySpec,
        error,
      });

      if (failedOperation) {
        next(
          options.failedOperationWorkflow.buildClientError(
            failedOperation,
            failureCapture.requestContext,
          ),
        );
        return;
      }
    }

    next(error);
  }
}

export function createGovernanceMutationRouter(options: GovernanceMutationRouterOptions): Router {
  const router = Router();
  const authenticate = createAuthenticationMiddleware(options.authSessionClient, options.config);
  const idempotency = createIdempotencyMiddleware(options.idempotencyStore);

  router.use(
    '/governance',
    authenticate,
    requireMutationWriteAccess(),
    requireOperatorActionCapability('governance:write'),
    requireDirectSignGovernancePath,
  );

  router.post('/governance/pause', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'pause',
            contractMethod: 'pause',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (status.paused) {
          throw new GatewayError(409, 'CONFLICT', 'Protocol is already paused');
        }

        return options.mutationService.queueAction({
          category: 'pause',
          contractMethod: 'pause',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
        });
      },
    ),
  );

  router.post('/governance/unpause/proposal', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'unpause',
            contractMethod: 'proposeUnpause',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
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

        return options.mutationService.queueAction({
          category: 'unpause',
          contractMethod: 'proposeUnpause',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
        });
      },
    ),
  );

  router.post('/governance/unpause/proposal/approve', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'unpause',
            contractMethod: 'approveUnpause',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const walletAddress = requireWalletBoundSession(principal, 'Governance approval checks');
        const audit = validateGovernanceAuditInput(req.body);
        const proposal = await options.governanceReader.getUnpauseProposalState();
        if (!proposal.hasActiveProposal) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'No active unpause proposal is available to approve',
          );
        }

        if (await options.governanceReader.hasApprovedUnpause(walletAddress)) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Caller has already approved the active unpause proposal',
          );
        }

        return options.mutationService.queueAction({
          category: 'unpause',
          contractMethod: 'approveUnpause',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
        });
      },
    ),
  );

  router.post('/governance/unpause/proposal/cancel', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'unpause',
            contractMethod: 'cancelUnpauseProposal',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        requireWalletBoundSession(principal, 'Unpause proposal cancellation checks');
        const audit = validateGovernanceAuditInput(req.body);
        const proposal = await options.governanceReader.getUnpauseProposalState();
        if (!proposal.hasActiveProposal) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'No active unpause proposal is available to cancel',
          );
        }

        return options.mutationService.queueAction({
          category: 'unpause',
          contractMethod: 'cancelUnpauseProposal',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
        });
      },
    ),
  );

  router.post('/governance/claims/pause', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'claims_pause',
            contractMethod: 'pauseClaims',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (status.claimsPaused) {
          throw new GatewayError(409, 'CONFLICT', 'Claims are already paused');
        }

        return options.mutationService.queueAction({
          category: 'claims_pause',
          contractMethod: 'pauseClaims',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
        });
      },
    ),
  );

  router.post('/governance/claims/unpause', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'claims_unpause',
            contractMethod: 'unpauseClaims',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (!status.claimsPaused) {
          throw new GatewayError(409, 'CONFLICT', 'Claims are not currently paused');
        }

        return options.mutationService.queueAction({
          category: 'claims_unpause',
          contractMethod: 'unpauseClaims',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
        });
      },
    ),
  );

  router.post('/governance/treasury/sweep', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'treasury_sweep',
            contractMethod: 'claimTreasury',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
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

        return options.mutationService.queueAction({
          category: 'treasury_sweep',
          contractMethod: 'claimTreasury',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
        });
      },
    ),
  );

  router.post('/governance/treasury/payout-receiver/proposals', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const newPayoutReceiver = validateAddressInput(
          (req.body as Record<string, unknown>)?.newPayoutReceiver,
          'newPayoutReceiver',
        );
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'treasury_payout_receiver_update',
            contractMethod: 'proposeTreasuryPayoutAddressUpdate',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
            targetAddress: newPayoutReceiver,
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
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

        return options.mutationService.queueAction({
          category: 'treasury_payout_receiver_update',
          contractMethod: 'proposeTreasuryPayoutAddressUpdate',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
          targetAddress: newPayoutReceiver,
        });
      },
    ),
  );

  router.post(
    '/governance/treasury/payout-receiver/proposals/:proposalId/approve',
    idempotency,
    (req, res, next) =>
      queueAndRespond(
        req,
        res,
        next,
        options,
        (() => {
          const { principal, requestContext, idempotencyKey } = getMutationContext(req);
          const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
          return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
              type: 'governance.queue_action',
              category: 'treasury_payout_receiver_update',
              contractMethod: 'approveTreasuryPayoutAddressUpdate',
              routePath: req.originalUrl || req.path,
              audit: validateGovernanceAuditInput(req.body),
              proposalId,
            } satisfies GovernanceReplaySpec,
          };
        })(),
        async () => {
          const { principal, requestContext, idempotencyKey } = getMutationContext(req);
          const walletAddress = requireWalletBoundSession(
            principal,
            'Treasury payout receiver proposal approval',
          );
          const audit = validateGovernanceAuditInput(req.body);
          const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
          const proposal =
            await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
          if (!proposal) {
            throw new GatewayError(
              404,
              'NOT_FOUND',
              'Treasury payout receiver proposal not found',
              { proposalId },
            );
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
              walletAddress,
            )
          ) {
            throw new GatewayError(
              409,
              'CONFLICT',
              'Caller has already approved this treasury payout receiver proposal',
              { proposalId },
            );
          }

          return options.mutationService.queueAction({
            category: 'treasury_payout_receiver_update',
            contractMethod: 'approveTreasuryPayoutAddressUpdate',
            routePath: req.originalUrl || req.path,
            audit,
            principal,
            requestContext,
            idempotencyKey,
            proposalId,
            targetAddress: proposal.targetAddress,
          });
        },
      ),
  );

  router.post(
    '/governance/treasury/payout-receiver/proposals/:proposalId/execute',
    idempotency,
    (req, res, next) =>
      queueAndRespond(
        req,
        res,
        next,
        options,
        (() => {
          const { principal, requestContext, idempotencyKey } = getMutationContext(req);
          const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
          return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
              type: 'governance.queue_action',
              category: 'treasury_payout_receiver_update',
              contractMethod: 'executeTreasuryPayoutAddressUpdate',
              routePath: req.originalUrl || req.path,
              audit: validateGovernanceAuditInput(req.body),
              proposalId,
            } satisfies GovernanceReplaySpec,
          };
        })(),
        async () => {
          const { principal, requestContext, idempotencyKey } = getMutationContext(req);
          requireWalletBoundSession(principal, 'Treasury payout receiver proposal execution');
          const audit = validateGovernanceAuditInput(req.body);
          const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
          const proposal =
            await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
          if (!proposal) {
            throw new GatewayError(
              404,
              'NOT_FOUND',
              'Treasury payout receiver proposal not found',
              { proposalId },
            );
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

          return options.mutationService.queueAction({
            category: 'treasury_payout_receiver_update',
            contractMethod: 'executeTreasuryPayoutAddressUpdate',
            routePath: req.originalUrl || req.path,
            audit,
            principal,
            requestContext,
            idempotencyKey,
            proposalId,
            targetAddress: proposal.targetAddress,
          });
        },
      ),
  );

  router.post(
    '/governance/treasury/payout-receiver/proposals/:proposalId/cancel-expired',
    idempotency,
    (req, res, next) =>
      queueAndRespond(
        req,
        res,
        next,
        options,
        (() => {
          const { principal, requestContext, idempotencyKey } = getMutationContext(req);
          const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
          return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
              type: 'governance.queue_action',
              category: 'treasury_payout_receiver_update',
              contractMethod: 'cancelExpiredTreasuryPayoutAddressUpdateProposal',
              routePath: req.originalUrl || req.path,
              audit: validateGovernanceAuditInput(req.body),
              proposalId,
            } satisfies GovernanceReplaySpec,
          };
        })(),
        async () => {
          const { principal, requestContext, idempotencyKey } = getMutationContext(req);
          const audit = validateGovernanceAuditInput(req.body);
          const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
          const proposal =
            await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
          if (!proposal) {
            throw new GatewayError(
              404,
              'NOT_FOUND',
              'Treasury payout receiver proposal not found',
              { proposalId },
            );
          }
          if (proposal.executed || proposal.cancelled || !proposal.expired) {
            throw new GatewayError(
              409,
              'CONFLICT',
              'Treasury payout receiver proposal is not cancellable as expired',
              { proposalId },
            );
          }

          return options.mutationService.queueAction({
            category: 'treasury_payout_receiver_update',
            contractMethod: 'cancelExpiredTreasuryPayoutAddressUpdateProposal',
            routePath: req.originalUrl || req.path,
            audit,
            principal,
            requestContext,
            idempotencyKey,
            proposalId,
            targetAddress: proposal.targetAddress,
          });
        },
      ),
  );

  router.post('/governance/oracle/disable-emergency', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'oracle_disable_emergency',
            contractMethod: 'disableOracleEmergency',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = validateGovernanceAuditInput(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (!status.oracleActive) {
          throw new GatewayError(409, 'CONFLICT', 'Oracle is already disabled');
        }

        return options.mutationService.queueAction({
          category: 'oracle_disable_emergency',
          contractMethod: 'disableOracleEmergency',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
          targetAddress: status.oracleAddress,
        });
      },
    ),
  );

  router.post('/governance/oracle/proposals', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const newOracleAddress = validateAddressInput(
          (req.body as Record<string, unknown>)?.newOracleAddress,
          'newOracleAddress',
        );
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'oracle_update',
            contractMethod: 'proposeOracleUpdate',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
            targetAddress: newOracleAddress,
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
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

        return options.mutationService.queueAction({
          category: 'oracle_update',
          contractMethod: 'proposeOracleUpdate',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
          targetAddress: newOracleAddress,
        });
      },
    ),
  );

  router.post('/governance/oracle/proposals/:proposalId/approve', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'oracle_update',
            contractMethod: 'approveOracleUpdate',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
            proposalId,
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const walletAddress = requireWalletBoundSession(principal, 'Oracle proposal approval');
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

        if (await options.governanceReader.hasApprovedOracleProposal(proposalId, walletAddress)) {
          throw new GatewayError(
            409,
            'CONFLICT',
            'Caller has already approved this oracle update proposal',
            { proposalId },
          );
        }

        return options.mutationService.queueAction({
          category: 'oracle_update',
          contractMethod: 'approveOracleUpdate',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
          proposalId,
          targetAddress: proposal.targetAddress,
        });
      },
    ),
  );

  router.post('/governance/oracle/proposals/:proposalId/execute', idempotency, (req, res, next) =>
    queueAndRespond(
      req,
      res,
      next,
      options,
      (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
        return {
          principal,
          requestContext,
          idempotencyKey,
          replaySpec: {
            type: 'governance.queue_action',
            category: 'oracle_update',
            contractMethod: 'executeOracleUpdate',
            routePath: req.originalUrl || req.path,
            audit: validateGovernanceAuditInput(req.body),
            proposalId,
          } satisfies GovernanceReplaySpec,
        };
      })(),
      async () => {
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

        return options.mutationService.queueAction({
          category: 'oracle_update',
          contractMethod: 'executeOracleUpdate',
          routePath: req.originalUrl || req.path,
          audit,
          principal,
          requestContext,
          idempotencyKey,
          proposalId,
          targetAddress: proposal.targetAddress,
        });
      },
    ),
  );

  router.post(
    '/governance/oracle/proposals/:proposalId/cancel-expired',
    idempotency,
    (req, res, next) =>
      queueAndRespond(
        req,
        res,
        next,
        options,
        (() => {
          const { principal, requestContext, idempotencyKey } = getMutationContext(req);
          const proposalId = validateProposalId(getPathParam(req.params.proposalId, 'proposalId'));
          return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
              type: 'governance.queue_action',
              category: 'oracle_update',
              contractMethod: 'cancelExpiredOracleUpdateProposal',
              routePath: req.originalUrl || req.path,
              audit: validateGovernanceAuditInput(req.body),
              proposalId,
            } satisfies GovernanceReplaySpec,
          };
        })(),
        async () => {
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

          return options.mutationService.queueAction({
            category: 'oracle_update',
            contractMethod: 'cancelExpiredOracleUpdateProposal',
            routePath: req.originalUrl || req.path,
            audit,
            principal,
            requestContext,
            idempotencyKey,
            proposalId,
            targetAddress: proposal.targetAddress,
          });
        },
      ),
  );

  registerGovernanceDirectSignRoutes(router, idempotency, options);

  return router;
}
