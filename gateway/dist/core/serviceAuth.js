"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseServiceApiKeys = void 0;
exports.createServiceAuthHeaders = createServiceAuthHeaders;
exports.createServiceAuthMiddleware = createServiceAuthMiddleware;
exports.createServiceApiKeyLookup = createServiceApiKeyLookup;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const serviceAuth_1 = require("@agroasys/shared-auth/serviceAuth");
const crypto_1 = __importDefault(require("crypto"));
var serviceAuth_2 = require("@agroasys/shared-auth/serviceAuth");
Object.defineProperty(exports, "parseServiceApiKeys", { enumerable: true, get: function () { return serviceAuth_2.parseServiceApiKeys; } });
function createServiceAuthHeaders(input) {
    const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
    const nonce = input.nonce || crypto_1.default.randomBytes(16).toString('hex');
    const query = input.query ? input.query.replace(/^\?/, '') : '';
    const bodyBuffer = input.body === undefined || input.body === null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(input.body)
            ? input.body
            : typeof input.body === 'string'
                ? Buffer.from(input.body)
                : Buffer.from(JSON.stringify(input.body));
    const canonical = (0, serviceAuth_1.buildServiceAuthCanonicalString)({
        method: input.method.toUpperCase(),
        path: input.path,
        query,
        bodySha256: crypto_1.default.createHash('sha256').update(bodyBuffer).digest('hex'),
        timestamp,
        nonce,
    });
    return {
        'X-Api-Key': input.apiKey,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': (0, serviceAuth_1.signServiceAuthCanonicalString)(input.apiSecret, canonical),
    };
}
function createServiceAuthMiddleware(options) {
    return (0, serviceAuth_1.createServiceAuthMiddleware)(options);
}
function createServiceApiKeyLookup(rawKeys) {
    const keys = (0, serviceAuth_1.parseServiceApiKeys)(rawKeys);
    const lookup = new Map(keys.map((key) => [key.id, key]));
    return (apiKey) => lookup.get(apiKey);
}
//# sourceMappingURL=serviceAuth.js.map