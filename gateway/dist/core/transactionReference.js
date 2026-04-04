"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSettlementTransactionReference = buildSettlementTransactionReference;
exports.requiresCanonicalTxHash = requiresCanonicalTxHash;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const sdk_1 = require("@agroasys/sdk");
function normalizeHash(value) {
    const normalized = value?.trim() || null;
    return normalized && normalized.length > 0 ? normalized : null;
}
function buildSettlementTransactionReference(txHash, explorerBaseUrl) {
    const canonicalTxHash = normalizeHash(txHash);
    return {
        txHash: canonicalTxHash,
        explorerUrl: (0, sdk_1.buildExplorerTxUrl)(explorerBaseUrl, canonicalTxHash),
    };
}
function requiresCanonicalTxHash(executionStatus) {
    return executionStatus === 'submitted' || executionStatus === 'confirmed';
}
//# sourceMappingURL=transactionReference.js.map