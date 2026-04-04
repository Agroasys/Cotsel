"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOperatorCapabilitySnapshot = buildOperatorCapabilitySnapshot;
const auth_1 = require("../middleware/auth");
function buildOperatorCapabilitySnapshot(principal, config) {
    const canReadOperatorRoutes = principal.gatewayRoles.includes('operator:read');
    const allowlisted = (0, auth_1.matchesAllowlist)(principal.session, config.writeAllowlist);
    const canWriteOperatorActions = principal.gatewayRoles.includes('operator:write')
        && config.enableMutations
        && allowlisted;
    return {
        subject: {
            accountId: principal.session.accountId ?? principal.session.userId,
            userId: principal.session.userId,
            walletAddress: principal.session.walletAddress,
            authRole: principal.session.role,
            gatewayRoles: principal.gatewayRoles,
        },
        routes: {
            overviewRead: canReadOperatorRoutes,
            operationsRead: canReadOperatorRoutes,
            tradesRead: canReadOperatorRoutes,
            governanceRead: canReadOperatorRoutes,
            complianceRead: canReadOperatorRoutes,
        },
        actions: {
            governanceWrite: canWriteOperatorActions,
            complianceWrite: canWriteOperatorActions,
        },
        writeAccess: {
            mutationsConfigured: config.enableMutations,
            allowlisted,
            effective: canWriteOperatorActions,
        },
    };
}
//# sourceMappingURL=operatorCapabilities.js.map