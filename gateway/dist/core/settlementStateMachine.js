"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateExecutionTransition = validateExecutionTransition;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const errors_1 = require("../errors");
const EXECUTION_TRANSITIONS = {
    pending: ['accepted', 'queued', 'submitted', 'failed', 'rejected'],
    accepted: ['queued', 'submitted', 'failed', 'rejected'],
    queued: ['submitted', 'failed', 'rejected'],
    submitted: ['confirmed', 'failed', 'rejected'],
    confirmed: ['confirmed'],
    failed: ['failed'],
    rejected: ['rejected'],
};
const RECONCILIATION_EVENT_TYPES = new Set(['reconciled', 'drift_detected']);
function validateExecutionTransition(current, next, eventType) {
    if (RECONCILIATION_EVENT_TYPES.has(eventType)) {
        if (current !== 'confirmed') {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Reconciliation events require a confirmed settlement handoff', {
                currentExecutionStatus: current,
                eventType,
            });
        }
        if (next !== current) {
            throw new errors_1.GatewayError(409, 'CONFLICT', 'Reconciliation events cannot mutate settlement execution state', {
                currentExecutionStatus: current,
                nextExecutionStatus: next,
                eventType,
            });
        }
        return;
    }
    if (current === next) {
        return;
    }
    if (!EXECUTION_TRANSITIONS[current].includes(next)) {
        throw new errors_1.GatewayError(409, 'CONFLICT', 'Settlement execution event violates the handoff state machine', {
            currentExecutionStatus: current,
            nextExecutionStatus: next,
            eventType,
        });
    }
}
//# sourceMappingURL=settlementStateMachine.js.map