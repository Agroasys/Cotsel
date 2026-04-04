"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernanceCleanupService = void 0;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = require("crypto");
const governanceStore_1 = require("./governanceStore");
function buildStaleRecord(action, inspectedAt) {
    return {
        ...action,
        status: 'stale',
        errorCode: 'QUEUE_EXPIRED',
        errorMessage: 'Governance action exceeded the requested queue TTL before execution',
        executedAt: inspectedAt,
    };
}
function buildAuditEntry(action, requestId, inspectedAt) {
    return {
        eventType: 'governance.action.cleanup.stale',
        route: '/internal/cleanup/governance-actions',
        method: 'CLEANUP',
        requestId,
        correlationId: requestId,
        actorRole: 'system',
        status: 'stale',
        metadata: {
            actionId: action.actionId,
            intentKey: action.intentKey,
            inspectedAt,
            expiresAt: action.expiresAt,
            reasonCode: 'QUEUE_EXPIRED',
        },
    };
}
class GovernanceCleanupService {
    constructor(store, writeStore) {
        this.store = store;
        this.writeStore = writeStore;
    }
    async dryRun(now = new Date().toISOString(), limit = 100) {
        const actions = await this.store.listRequestedExpired(now, limit);
        return {
            requestId: `cleanup-preview-${(0, crypto_1.randomUUID)()}`,
            applied: false,
            staleCount: actions.length,
            actions,
            inspectedAt: now,
        };
    }
    async apply(now = new Date().toISOString(), limit = 100) {
        const requestId = `cleanup-${(0, crypto_1.randomUUID)()}`;
        const candidates = await this.store.listRequestedExpired(now, limit);
        const staleActions = [];
        for (const candidate of candidates) {
            const current = await this.store.get(candidate.actionId);
            if (!current || !(0, governanceStore_1.isExpiredRequestedGovernanceAction)(current, now)) {
                continue;
            }
            staleActions.push(await this.writeStore.saveActionWithAudit(buildStaleRecord(current, now), buildAuditEntry(current, requestId, now)));
        }
        return {
            requestId,
            applied: true,
            staleCount: staleActions.length,
            actions: staleActions,
            inspectedAt: now,
        };
    }
}
exports.GovernanceCleanupService = GovernanceCleanupService;
//# sourceMappingURL=governanceCleanupService.js.map