"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadExecutorConfig = loadExecutorConfig;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const assert_1 = require("assert");
const env_1 = require("./env");
const sdk_1 = require("@agroasys/sdk");
function env(name) {
    const value = process.env[name];
    (0, assert_1.strict)(value, `${name} is missing`);
    return value;
}
function assertAddress(name, value) {
    (0, assert_1.strict)(/^0x[a-fA-F0-9]{40}$/.test(value), `${name} must be a 20-byte hex address`);
    return value;
}
function assertPrivateKey(name, value) {
    (0, assert_1.strict)(/^0x[a-fA-F0-9]{64}$/.test(value), `${name} must be a 32-byte hex private key`);
    return value;
}
function loadExecutorConfig(baseConfig) {
    const gatewayConfig = baseConfig ?? (0, env_1.loadConfig)();
    const executionTimeoutMs = Number.parseInt(process.env.GATEWAY_EXECUTOR_TIMEOUT_MS || '45000', 10);
    (0, assert_1.strict)(Number.isInteger(executionTimeoutMs) && executionTimeoutMs >= 1000, 'GATEWAY_EXECUTOR_TIMEOUT_MS must be >= 1000');
    return {
        ...gatewayConfig,
        usdcAddress: assertAddress('GATEWAY_USDC_ADDRESS', (0, sdk_1.resolveSettlementRuntime)({
            runtimeKey: gatewayConfig.settlementRuntimeKey,
            rpcUrl: gatewayConfig.rpcUrl,
            rpcFallbackUrls: gatewayConfig.rpcFallbackUrls,
            chainId: gatewayConfig.chainId,
            explorerBaseUrl: gatewayConfig.explorerBaseUrl,
            escrowAddress: gatewayConfig.escrowAddress,
            usdcAddress: process.env.GATEWAY_USDC_ADDRESS ? assertAddress('GATEWAY_USDC_ADDRESS', env('GATEWAY_USDC_ADDRESS')) : null,
        }).usdcAddress ?? assertAddress('GATEWAY_USDC_ADDRESS', env('GATEWAY_USDC_ADDRESS'))),
        executorPrivateKey: assertPrivateKey('GATEWAY_EXECUTOR_PRIVATE_KEY', env('GATEWAY_EXECUTOR_PRIVATE_KEY')),
        executionTimeoutMs,
    };
}
//# sourceMappingURL=executorEnv.js.map