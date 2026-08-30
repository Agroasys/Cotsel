/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { loadConfigModule, withEnv } from './helpers/gatewayConfigTestHarness';

describe('durable gasless command configuration', () => {
  test('loads explicit lease, retry, wait, batch, and capacity bounds', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_GASLESS_COMMAND_LEASE_MS: '45000',
        GATEWAY_GASLESS_COMMAND_POLL_INTERVAL_MS: '1500',
        GATEWAY_GASLESS_COMMAND_RETRY_INITIAL_MS: '2000',
        GATEWAY_GASLESS_COMMAND_RETRY_MAX_MS: '20000',
        GATEWAY_GASLESS_COMMAND_WAIT_TIMEOUT_MS: '12000',
        GATEWAY_GASLESS_COMMAND_MAX_ATTEMPTS: '6',
        GATEWAY_GASLESS_COMMAND_MAX_BATCH: '20',
        GATEWAY_GASLESS_COMMAND_MAX_PENDING: '80',
      },
      () => {
        const config = loadConfigModule().loadConfig();
        expect(config).toMatchObject({
          gaslessCommandLeaseMs: 45000,
          gaslessCommandPollIntervalMs: 1500,
          gaslessCommandRetryInitialMs: 2000,
          gaslessCommandRetryMaxMs: 20000,
          gaslessCommandWaitTimeoutMs: 12000,
          gaslessCommandMaxAttempts: 6,
          gaslessCommandMaxBatch: 20,
          gaslessCommandMaxPending: 80,
        });
      },
    );
  });

  test('rejects a retry ceiling below the initial delay', () => {
    withEnv(
      {
        GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
        GATEWAY_RPC_URL: undefined,
        GATEWAY_CHAIN_ID: undefined,
        GATEWAY_GASLESS_COMMAND_RETRY_INITIAL_MS: '2000',
        GATEWAY_GASLESS_COMMAND_RETRY_MAX_MS: '1000',
      },
      () => {
        expect(() => loadConfigModule().loadConfig()).toThrow(
          'GATEWAY_GASLESS_COMMAND_RETRY_MAX_MS must be >= GATEWAY_GASLESS_COMMAND_RETRY_INITIAL_MS',
        );
      },
    );
  });
});
