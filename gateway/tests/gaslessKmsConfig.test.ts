/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { loadConfigModule, withEnv } from './helpers/gatewayConfigTestHarness';

test('KMS custody parses a direct IAM-authenticated key identity', () => {
  withEnv(
    {
      GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
      GATEWAY_RPC_URL: undefined,
      GATEWAY_RPC_FALLBACK_URLS: 'https://fallback.example.test',
      GATEWAY_CHAIN_ID: undefined,
      GATEWAY_GASLESS_EXECUTION_ENABLED: 'true',
      GATEWAY_GASLESS_SIGNER_CUSTODY_MODE: 'kms',
      GATEWAY_GASLESS_KMS_KEY_ID: 'alias/cotsel-staging-relayer',
      GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS: '0x1111111111111111111111111111111111111111',
      GATEWAY_GASLESS_MIN_EXECUTOR_BALANCE_WEI: '10000000000000000000',
      GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI: '10000000000000000000',
    },
    () => {
      const config = loadConfigModule().loadConfig();
      expect(config.gaslessSignerCustodyMode).toBe('kms');
      expect(config.gaslessKmsKeyId).toBe('alias/cotsel-staging-relayer');
      expect(config.gaslessKmsExpectedAddress).toBe('0x1111111111111111111111111111111111111111');
      expect(config.gaslessManagedSignerUrl).toBeUndefined();
    },
  );
});
