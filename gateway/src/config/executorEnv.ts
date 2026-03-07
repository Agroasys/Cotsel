/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { strict as assert } from 'assert';
import { GatewayConfig, loadConfig } from './env';

export interface GovernanceExecutorConfig extends GatewayConfig {
  usdcAddress: string;
  executorPrivateKey: string;
  executionTimeoutMs: number;
}

function env(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is missing`);
  return value;
}

function assertAddress(name: string, value: string): string {
  assert(/^0x[a-fA-F0-9]{40}$/.test(value), `${name} must be a 20-byte hex address`);
  return value;
}

function assertPrivateKey(name: string, value: string): string {
  assert(/^0x[a-fA-F0-9]{64}$/.test(value), `${name} must be a 32-byte hex private key`);
  return value;
}

export function loadExecutorConfig(baseConfig?: GatewayConfig): GovernanceExecutorConfig {
  const gatewayConfig = baseConfig ?? loadConfig();
  const executionTimeoutMs = Number.parseInt(process.env.GATEWAY_EXECUTOR_TIMEOUT_MS || '45000', 10);
  assert(Number.isInteger(executionTimeoutMs) && executionTimeoutMs >= 1000, 'GATEWAY_EXECUTOR_TIMEOUT_MS must be >= 1000');

  return {
    ...gatewayConfig,
    usdcAddress: assertAddress('GATEWAY_USDC_ADDRESS', env('GATEWAY_USDC_ADDRESS')),
    executorPrivateKey: assertPrivateKey('GATEWAY_EXECUTOR_PRIVATE_KEY', env('GATEWAY_EXECUTOR_PRIVATE_KEY')),
    executionTimeoutMs,
  };
}
