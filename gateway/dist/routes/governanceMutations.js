"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGovernanceMutationRouter = createGovernanceMutationRouter;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const express_1 = require("express");
const governanceMutationService_1 = require("../core/governanceMutationService");
const auth_1 = require("../middleware/auth");
const idempotency_1 = require("../middleware/idempotency");
const errors_1 = require("../errors");
const responses_1 = require("../responses");
function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}
function getMutationContext(req) {
    if (!req.gatewayPrincipal) {
        throw new errors_1.GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    if (!req.requestContext) {
        throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Request context was not initialized');
    }
    if (!req.idempotencyState?.idempotencyKey) {
        throw new errors_1.GatewayError(500, 'INTERNAL_ERROR', 'Idempotency context was not initialized');
    }
    return {
        principal: req.gatewayPrincipal,
        requestContext: req.requestContext,
        idempotencyKey: req.idempotencyState.idempotencyKey,
    };
}
function getPathParam(value, field) {
    if (Array.isArray(value)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `Path parameter ${field} must be a string`);
    }
    return value;
}
async function queueAndRespond(req, res, next, options, failureCapture, actionFactory) {
    try {
        const accepted = await actionFactory();
        res.status(202).json((0, responses_1.successResponse)(accepted));
    }
    catch (error) {
        if (options.failedOperationWorkflow) {
            const failedOperation = await options.failedOperationWorkflow.captureFailure({
                operationType: 'governance.queue_action',
                operationKey: `${(0, auth_1.resolveGatewayActorKey)(failureCapture.principal.session)}:${req.originalUrl || req.path}:${failureCapture.idempotencyKey}`,
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
                next(options.failedOperationWorkflow.buildClientError(failedOperation, failureCapture.requestContext));
                return;
            }
        }
        next(error);
    }
}
function createGovernanceMutationRouter(options) {
    const router = (0, express_1.Router)();
    const authenticate = (0, auth_1.createAuthenticationMiddleware)(options.authSessionClient, options.config);
    const idempotency = (0, idempotency_1.createIdempotencyMiddleware)(options.idempotencyStore);
    router.use('/governance', authenticate, (0, auth_1.requireMutationWriteAccess)());
    router.post('/governance/pause', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
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
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (status.paused) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Protocol is already paused');
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
    }));
    router.post('/governance/unpause/proposal', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
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
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (!status.paused) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Protocol must be paused before creating an unpause proposal');
        }
        if (!status.oracleActive) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Oracle must be active before creating an unpause proposal');
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
    }));
    router.post('/governance/unpause/proposal/approve', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
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
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const walletAddress = (0, auth_1.requireWalletBoundSession)(principal, 'Governance approval checks');
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const proposal = await options.governanceReader.getUnpauseProposalState();
        if (!proposal.hasActiveProposal) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'No active unpause proposal is available to approve');
        }
        if (await options.governanceReader.hasApprovedUnpause(walletAddress)) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Caller has already approved the active unpause proposal');
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
    }));
    router.post('/governance/unpause/proposal/cancel', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
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
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const walletAddress = (0, auth_1.requireWalletBoundSession)(principal, 'Treasury payout approval checks');
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const proposal = await options.governanceReader.getUnpauseProposalState();
        if (!proposal.hasActiveProposal) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'No active unpause proposal is available to cancel');
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
    }));
    router.post('/governance/claims/pause', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
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
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (status.claimsPaused) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Claims are already paused');
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
    }));
    router.post('/governance/claims/unpause', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
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
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (!status.claimsPaused) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Claims are not currently paused');
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
    }));
    router.post('/governance/treasury/sweep', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
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
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (status.claimsPaused) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Treasury sweep is unavailable while claims are paused');
        }
        const claimableBalance = await options.governanceReader.getTreasuryClaimableBalance();
        if (claimableBalance <= 0n) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Treasury claimable balance is zero');
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
    }));
    router.post('/governance/treasury/payout-receiver/proposals', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const newPayoutReceiver = (0, governanceMutationService_1.validateAddressInput)(req.body?.newPayoutReceiver, 'newPayoutReceiver');
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'governance.queue_action',
                category: 'treasury_payout_receiver_update',
                contractMethod: 'proposeTreasuryPayoutAddressUpdate',
                routePath: req.originalUrl || req.path,
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
                targetAddress: newPayoutReceiver,
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        const newPayoutReceiver = (0, governanceMutationService_1.validateAddressInput)(req.body?.newPayoutReceiver, 'newPayoutReceiver');
        if (newPayoutReceiver.toLowerCase() === status.treasuryPayoutAddress.toLowerCase()) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'New payout receiver matches the current treasury payout receiver');
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
    }));
    router.post('/governance/treasury/payout-receiver/proposals/:proposalId/approve', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'governance.queue_action',
                category: 'treasury_payout_receiver_update',
                contractMethod: 'approveTreasuryPayoutAddressUpdate',
                routePath: req.originalUrl || req.path,
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
                proposalId,
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const walletAddress = (0, auth_1.requireWalletBoundSession)(principal, 'Treasury payout receiver proposal approval');
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
        if (!proposal) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', { proposalId });
        }
        if (proposal.executed || proposal.cancelled || proposal.expired) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal is no longer approvable', { proposalId });
        }
        if (await options.governanceReader.hasApprovedTreasuryPayoutReceiverProposal(proposalId, walletAddress)) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Caller has already approved this treasury payout receiver proposal', { proposalId });
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
    }));
    router.post('/governance/treasury/payout-receiver/proposals/:proposalId/execute', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'governance.queue_action',
                category: 'treasury_payout_receiver_update',
                contractMethod: 'executeTreasuryPayoutAddressUpdate',
                routePath: req.originalUrl || req.path,
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
                proposalId,
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const walletAddress = (0, auth_1.requireWalletBoundSession)(principal, 'Oracle update approval checks');
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
        if (!proposal) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', { proposalId });
        }
        if (proposal.executed || proposal.cancelled || proposal.expired) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal is not executable', { proposalId });
        }
        const status = await options.governanceReader.getGovernanceStatus();
        if (proposal.approvalCount < status.governanceApprovalsRequired) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal does not have enough approvals', { proposalId });
        }
        if (proposal.etaSeconds > nowSeconds()) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal timelock has not elapsed', { proposalId });
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
    }));
    router.post('/governance/treasury/payout-receiver/proposals/:proposalId/cancel-expired', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'governance.queue_action',
                category: 'treasury_payout_receiver_update',
                contractMethod: 'cancelExpiredTreasuryPayoutAddressUpdateProposal',
                routePath: req.originalUrl || req.path,
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
                proposalId,
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getTreasuryPayoutReceiverProposalState(proposalId);
        if (!proposal) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Treasury payout receiver proposal not found', { proposalId });
        }
        if (proposal.executed || proposal.cancelled || !proposal.expired) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Treasury payout receiver proposal is not cancellable as expired', { proposalId });
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
    }));
    router.post('/governance/oracle/disable-emergency', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
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
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        if (!status.oracleActive) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Oracle is already disabled');
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
    }));
    router.post('/governance/oracle/proposals', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const newOracleAddress = (0, governanceMutationService_1.validateAddressInput)(req.body?.newOracleAddress, 'newOracleAddress');
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'governance.queue_action',
                category: 'oracle_update',
                contractMethod: 'proposeOracleUpdate',
                routePath: req.originalUrl || req.path,
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
                targetAddress: newOracleAddress,
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const status = await options.governanceReader.getGovernanceStatus();
        const newOracleAddress = (0, governanceMutationService_1.validateAddressInput)(req.body?.newOracleAddress, 'newOracleAddress');
        if (newOracleAddress.toLowerCase() === status.oracleAddress.toLowerCase()) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'New oracle address matches the current oracle address');
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
    }));
    router.post('/governance/oracle/proposals/:proposalId/approve', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'governance.queue_action',
                category: 'oracle_update',
                contractMethod: 'approveOracleUpdate',
                routePath: req.originalUrl || req.path,
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
                proposalId,
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const walletAddress = (0, auth_1.requireWalletBoundSession)(principal, 'Oracle proposal approval');
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getOracleProposalState(proposalId);
        if (!proposal) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', { proposalId });
        }
        if (proposal.executed || proposal.cancelled || proposal.expired) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Oracle update proposal is no longer approvable', { proposalId });
        }
        if (await options.governanceReader.hasApprovedOracleProposal(proposalId, walletAddress)) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Caller has already approved this oracle update proposal', { proposalId });
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
    }));
    router.post('/governance/oracle/proposals/:proposalId/execute', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'governance.queue_action',
                category: 'oracle_update',
                contractMethod: 'executeOracleUpdate',
                routePath: req.originalUrl || req.path,
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
                proposalId,
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getOracleProposalState(proposalId);
        if (!proposal) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', { proposalId });
        }
        if (proposal.executed || proposal.cancelled || proposal.expired) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Oracle update proposal is not executable', { proposalId });
        }
        const status = await options.governanceReader.getGovernanceStatus();
        if (proposal.approvalCount < status.governanceApprovalsRequired) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Oracle update proposal does not have enough approvals', { proposalId });
        }
        if (proposal.etaSeconds > nowSeconds()) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Oracle update proposal timelock has not elapsed', { proposalId });
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
    }));
    router.post('/governance/oracle/proposals/:proposalId/cancel-expired', idempotency, (req, res, next) => queueAndRespond(req, res, next, options, (() => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        return {
            principal,
            requestContext,
            idempotencyKey,
            replaySpec: {
                type: 'governance.queue_action',
                category: 'oracle_update',
                contractMethod: 'cancelExpiredOracleUpdateProposal',
                routePath: req.originalUrl || req.path,
                audit: (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body),
                proposalId,
            },
        };
    })(), async () => {
        const { principal, requestContext, idempotencyKey } = getMutationContext(req);
        const audit = (0, governanceMutationService_1.validateGovernanceAuditInput)(req.body);
        const proposalId = (0, governanceMutationService_1.validateProposalId)(getPathParam(req.params.proposalId, 'proposalId'));
        const proposal = await options.governanceReader.getOracleProposalState(proposalId);
        if (!proposal) {
            throw new errors_1.GatewayError(404, 'NOT_FOUND', 'Oracle update proposal not found', { proposalId });
        }
        if (proposal.executed || proposal.cancelled || !proposal.expired) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Oracle update proposal is not cancellable as expired', { proposalId });
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
    }));
    return router;
}
//# sourceMappingURL=governanceMutations.js.map