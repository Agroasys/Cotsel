"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldExitNonZeroForGovernanceAction = shouldExitNonZeroForGovernanceAction;
const NON_ZERO_EXIT_STATUSES = new Set([
    'failed',
    'submitted',
    'stale',
]);
function shouldExitNonZeroForGovernanceAction(status) {
    return NON_ZERO_EXIT_STATUSES.has(status);
}
//# sourceMappingURL=runGovernanceActionStatus.js.map