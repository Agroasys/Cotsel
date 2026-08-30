/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { strict as assert } from 'assert';
import type { GatewayConfig } from './gatewayConfig';
import { envPositiveInteger } from './environmentValues';

type GaslessCommandConfig = Required<
  Pick<
    GatewayConfig,
    | 'gaslessCommandLeaseMs'
    | 'gaslessCommandPollIntervalMs'
    | 'gaslessCommandRetryInitialMs'
    | 'gaslessCommandRetryMaxMs'
    | 'gaslessCommandWaitTimeoutMs'
    | 'gaslessCommandMaxAttempts'
    | 'gaslessCommandMaxBatch'
    | 'gaslessCommandMaxPending'
  >
>;

export function loadGaslessCommandConfig(): GaslessCommandConfig {
  const config: GaslessCommandConfig = {
    gaslessCommandLeaseMs: envPositiveInteger('GATEWAY_GASLESS_COMMAND_LEASE_MS', 30_000),
    gaslessCommandPollIntervalMs: envPositiveInteger(
      'GATEWAY_GASLESS_COMMAND_POLL_INTERVAL_MS',
      1_000,
    ),
    gaslessCommandRetryInitialMs: envPositiveInteger(
      'GATEWAY_GASLESS_COMMAND_RETRY_INITIAL_MS',
      1_000,
    ),
    gaslessCommandRetryMaxMs: envPositiveInteger('GATEWAY_GASLESS_COMMAND_RETRY_MAX_MS', 30_000),
    gaslessCommandWaitTimeoutMs: envPositiveInteger(
      'GATEWAY_GASLESS_COMMAND_WAIT_TIMEOUT_MS',
      15_000,
    ),
    gaslessCommandMaxAttempts: envPositiveInteger('GATEWAY_GASLESS_COMMAND_MAX_ATTEMPTS', 5),
    gaslessCommandMaxBatch: envPositiveInteger('GATEWAY_GASLESS_COMMAND_MAX_BATCH', 25),
    gaslessCommandMaxPending: envPositiveInteger('GATEWAY_GASLESS_COMMAND_MAX_PENDING', 100),
  };

  assert(config.gaslessCommandLeaseMs >= 3_000, 'GATEWAY_GASLESS_COMMAND_LEASE_MS must be >= 3000');
  assert(
    config.gaslessCommandPollIntervalMs >= 100,
    'GATEWAY_GASLESS_COMMAND_POLL_INTERVAL_MS must be >= 100',
  );
  assert(
    config.gaslessCommandRetryInitialMs >= 100,
    'GATEWAY_GASLESS_COMMAND_RETRY_INITIAL_MS must be >= 100',
  );
  assert(
    config.gaslessCommandRetryMaxMs >= config.gaslessCommandRetryInitialMs,
    'GATEWAY_GASLESS_COMMAND_RETRY_MAX_MS must be >= GATEWAY_GASLESS_COMMAND_RETRY_INITIAL_MS',
  );
  assert(
    config.gaslessCommandWaitTimeoutMs >= 1_000,
    'GATEWAY_GASLESS_COMMAND_WAIT_TIMEOUT_MS must be >= 1000',
  );
  assert(
    config.gaslessCommandMaxAttempts <= 20,
    'GATEWAY_GASLESS_COMMAND_MAX_ATTEMPTS must be <= 20',
  );
  assert(config.gaslessCommandMaxBatch <= 100, 'GATEWAY_GASLESS_COMMAND_MAX_BATCH must be <= 100');
  return config;
}
