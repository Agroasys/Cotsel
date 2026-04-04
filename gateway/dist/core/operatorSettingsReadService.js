"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OperatorSettingsReadService = void 0;
function latestAssignedAt(items) {
    return items[0]?.assignedAt ?? null;
}
function latestCreatedAt(items) {
    return items[0]?.createdAt ?? null;
}
class OperatorSettingsReadService {
    constructor(roleAssignmentStore, auditFeedStore, now = () => new Date()) {
        this.roleAssignmentStore = roleAssignmentStore;
        this.auditFeedStore = auditFeedStore;
        this.now = now;
    }
    async listRoleAssignments(input) {
        const result = await this.roleAssignmentStore.list(input);
        return {
            items: result.items,
            nextCursor: result.nextCursor,
            freshness: {
                source: 'gateway_role_assignments',
                sourceFreshAt: latestAssignedAt(result.items),
                queriedAt: this.now().toISOString(),
                available: true,
            },
        };
    }
    async listAuditFeed(input) {
        const result = await this.auditFeedStore.list(input);
        return {
            items: result.items,
            nextCursor: result.nextCursor,
            freshness: {
                source: 'gateway_audit_log',
                sourceFreshAt: latestCreatedAt(result.items),
                queriedAt: this.now().toISOString(),
                available: true,
            },
        };
    }
}
exports.OperatorSettingsReadService = OperatorSettingsReadService;
//# sourceMappingURL=operatorSettingsReadService.js.map