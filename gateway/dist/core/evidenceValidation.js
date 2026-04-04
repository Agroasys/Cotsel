"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEvidenceLink = validateEvidenceLink;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const errors_1 = require("../errors");
const VALID_EVIDENCE_KINDS = new Set([
    'runbook',
    'incident',
    'ticket',
    'tx',
    'event',
    'document',
    'log',
    'dashboard',
    'other',
]);
function validateEvidenceLink(link, index) {
    if (!VALID_EVIDENCE_KINDS.has(link.kind)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `audit.evidenceLinks[${index}].kind is invalid`);
    }
    if (typeof link.uri !== 'string' || link.uri.trim().length < 3) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `audit.evidenceLinks[${index}].uri is required`);
    }
    if (link.note !== undefined && (typeof link.note !== 'string' || link.note.trim().length === 0)) {
        throw new errors_1.GatewayError(400, 'VALIDATION_ERROR', `audit.evidenceLinks[${index}].note must be a non-empty string when provided`);
    }
}
//# sourceMappingURL=evidenceValidation.js.map