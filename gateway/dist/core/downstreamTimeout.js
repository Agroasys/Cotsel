"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withTimeout = withTimeout;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const errors_1 = require("../errors");
async function withTimeout(promise, timeoutMs, message, options = {}) {
    let timeoutHandle;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new errors_1.GatewayError(options.statusCode ?? 503, options.code ?? 'UPSTREAM_UNAVAILABLE', message, {
                        timeoutMs,
                        cause: 'timeout',
                        ...(options.details ?? {}),
                    }));
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
//# sourceMappingURL=downstreamTimeout.js.map