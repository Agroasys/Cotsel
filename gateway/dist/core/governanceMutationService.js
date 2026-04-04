"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernanceMutationService = void 0;
exports.validateGovernanceAuditInput = validateGovernanceAuditInput;
exports.validateProposalId = validateProposalId;
exports.validateAddressInput = validateAddressInput;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = require("crypto");
const ethers_1 = require("ethers");
const governanceStore_1 = require("./governanceStore");
const auth_1 = require("../middleware/auth");
const errors_1 = require("../errors");
const evidenceValidation_1 = require("./evidenceValidation");
function resolveGovernanceActorId(principal) {
    return (0, auth_1.resolveGatewayActorKey)(principal.session);
}
function buildGovernanceIntentHash(intentKey) {
    return (0, crypto_1.createHash)('sha256').update(intentKey).digest('hex');
}
function validateGovernanceAuditInput(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
    }
    const body = raw;
    if (body.actionId !== undefined) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'actionId is server-generated and must not be provided by the client');
    }
    const audit = body.audit;
    if (!audit || typeof audit !== 'object') {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Request body must include audit metadata');
    }
    const auditRecord = audit;
    const reason = typeof auditRecord.reason === 'string' ? auditRecord.reason.trim() : '';
    const ticketRef = typeof auditRecord.ticketRef === 'string' ? auditRecord.ticketRef.trim() : '';
    const evidenceLinks = Array.isArray(auditRecord.evidenceLinks) ? auditRecord.evidenceLinks : [];
    if (reason.length < 8 || reason.length > 2000) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'audit.reason must be between 8 and 2000 characters');
    }
    if (ticketRef.length < 2 || ticketRef.length > 128) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'audit.ticketRef must be between 2 and 128 characters');
    }
    if (evidenceLinks.length < 1) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'audit.evidenceLinks must contain at least one item');
    }
    evidenceLinks.forEach((link, index) => (0, evidenceValidation_1.validateEvidenceLink)(link, index));
    return {
        reason,
        evidenceLinks: evidenceLinks.map((link) => ({
            kind: link.kind,
            uri: link.uri.trim(),
            ...(link.note ? { note: link.note.trim() } : {}),
        })),
        ticketRef,
    };
}
function validateProposalId(raw) {
    if (!raw || !/^\d+$/.test(raw)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', 'Path parameter proposalId must be a non-negative integer');
    }
    return Number.parseInt(raw, 10);
}
function validateAddressInput(value, field) {
    if (typeof value !== 'string' || !(0, ethers_1.isAddress)(value)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} must be a valid address`);
    }
    if (value === ethers_1.ZeroAddress) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `${field} cannot be the zero address`);
    }
    return value;
}
function buildAuditRecord(audit, principal, acceptedAt) {
    const actorWallet = (0, auth_1.requireWalletBoundSession)(principal, 'Governance mutation queuing');
    return {
        reason: audit.reason,
        evidenceLinks: audit.evidenceLinks,
        ticketRef: audit.ticketRef,
        actorSessionId: principal.sessionReference,
        actorWallet,
        actorRole: principal.session.role,
        createdAt: acceptedAt,
        requestedBy: principal.session.userId,
    };
}
class GovernanceMutationService {
    constructor(config, actionStore, writeStore) {
        this.config = config;
        this.actionStore = actionStore;
        this.writeStore = writeStore;
    }
    async queueAction(input) {
        const acceptedAt = new Date().toISOString();
        const expiresAt = new Date(Date.parse(acceptedAt) + (this.config.governanceQueueTtlSeconds * 1000)).toISOString();
        const approverWallet = (0, auth_1.requireWalletBoundSession)(input.principal, 'Governance mutation queuing');
        const intentKey = (0, governanceStore_1.buildGovernanceIntentKey)({
            category: input.category,
            contractMethod: input.contractMethod,
            proposalId: input.proposalId ?? null,
            targetAddress: input.targetAddress ?? null,
            tradeId: input.tradeId ?? null,
            chainId: this.config.chainId,
            approverWallet,
        });
        const intentHash = buildGovernanceIntentHash(intentKey);
        const actionId = (0, crypto_1.randomUUID)();
        const actorId = resolveGovernanceActorId(input.principal);
        const record = {
            actionId,
            intentKey,
            intentHash,
            proposalId: input.proposalId ?? null,
            category: input.category,
            status: 'requested',
            contractMethod: input.contractMethod,
            txHash: null,
            extrinsicHash: null,
            blockNumber: null,
            tradeId: input.tradeId ?? null,
            chainId: String(this.config.chainId),
            targetAddress: input.targetAddress ?? null,
            createdAt: acceptedAt,
            expiresAt,
            executedAt: null,
            requestId: input.requestContext.requestId,
            correlationId: input.requestContext.correlationId,
            idempotencyKey: input.idempotencyKey,
            actorId,
            endpoint: input.routePath,
            errorCode: null,
            errorMessage: null,
            audit: buildAuditRecord(input.audit, input.principal, acceptedAt),
        };
        const auditEntry = {
            eventType: 'governance.action.queued',
            route: input.routePath,
            method: 'POST',
            requestId: input.requestContext.requestId,
            correlationId: input.requestContext.correlationId,
            actionId,
            idempotencyKey: input.idempotencyKey,
            actorId,
            actorUserId: input.principal.session.userId,
            actorWalletAddress: input.principal.session.walletAddress,
            actorRole: input.principal.session.role,
            status: 'requested',
            metadata: {
                actionId,
                category: input.category,
                proposalId: input.proposalId ?? null,
                targetAddress: input.targetAddress ?? null,
                actorId,
                intentHash,
                idempotencyKey: input.idempotencyKey,
            },
        };
        const duplicateAuditEntry = (existing) => ({
            eventType: 'governance.action.duplicate_reused',
            route: input.routePath,
            method: 'POST',
            requestId: input.requestContext.requestId,
            correlationId: input.requestContext.correlationId,
            actionId: existing.actionId,
            idempotencyKey: input.idempotencyKey,
            actorId,
            actorUserId: input.principal.session.userId,
            actorWalletAddress: input.principal.session.walletAddress,
            actorRole: input.principal.session.role,
            status: existing.status,
            metadata: {
                actionId: existing.actionId,
                category: existing.category,
                proposalId: existing.proposalId,
                targetAddress: existing.targetAddress,
                intentKey: existing.intentKey,
                intentHash: existing.intentHash ?? intentHash,
                actorId: existing.actorId ?? actorId,
                idempotencyKey: input.idempotencyKey,
            },
        });
        const saved = await this.writeStore.saveQueuedActionWithIntentDedupe(record, auditEntry, duplicateAuditEntry, acceptedAt);
        const stored = saved.created ? record : (await this.actionStore.get(saved.action.actionId)) ?? saved.action;
        return {
            actionId: stored.actionId,
            intentKey: stored.intentKey,
            proposalId: stored.proposalId,
            category: stored.category,
            status: stored.status,
            acceptedAt: stored.createdAt,
            expiresAt: stored.expiresAt,
        };
    }
}
exports.GovernanceMutationService = GovernanceMutationService;
//# sourceMappingURL=governanceMutationService.js.map