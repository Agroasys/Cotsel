/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { strict as assert } from 'assert';
import { isAddress } from 'ethers';

export type GaslessSignerCustodyMode = 'raw_private_key' | 'kms' | 'mpc';

interface GaslessSignerCustodyConfig {
  enabled: boolean;
  mode: GaslessSignerCustodyMode;
  executorPrivateKey?: string;
  kmsKeyId?: string;
  kmsExpectedAddress?: string;
  managedSignerUrl?: string;
  managedSignerApiKey?: string;
}

export function parseGaslessSignerCustodyMode(value: string | undefined): GaslessSignerCustodyMode {
  const normalized = value?.trim() || 'raw_private_key';
  if (normalized === 'raw_private_key' || normalized === 'kms' || normalized === 'mpc') {
    return normalized;
  }

  throw new Error('GATEWAY_GASLESS_SIGNER_CUSTODY_MODE must be raw_private_key, kms, or mpc');
}

export function validateGaslessSignerCustodyConfig(config: GaslessSignerCustodyConfig): void {
  if (!config.enabled) return;

  if (config.mode !== 'raw_private_key') {
    assert(
      !config.executorPrivateKey,
      'GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY must not be set when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE is kms or mpc',
    );
  }
  if (config.mode === 'raw_private_key') {
    assert(
      config.executorPrivateKey,
      'GATEWAY_GASLESS_EXECUTION_ENABLED requires GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY or GATEWAY_EXECUTOR_PRIVATE_KEY when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE=raw_private_key',
    );
  } else if (config.mode === 'kms') {
    assert(
      config.kmsKeyId,
      'GATEWAY_GASLESS_KMS_KEY_ID is required when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE is kms',
    );
    assert(
      config.kmsExpectedAddress && isAddress(config.kmsExpectedAddress),
      'GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS must be a valid EVM address when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE is kms',
    );
    assert(
      !config.managedSignerUrl && !config.managedSignerApiKey,
      'KMS custody uses direct IAM authentication; managed signer URL and API key must not be set',
    );
  } else {
    assert(
      config.managedSignerUrl,
      'GATEWAY_GASLESS_MANAGED_SIGNER_URL is required when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE is mpc',
    );
    assert(
      config.managedSignerUrl?.startsWith('https://'),
      'Managed gasless signer custody requires an https GATEWAY_GASLESS_MANAGED_SIGNER_URL',
    );
    assert(
      Boolean(config.managedSignerApiKey),
      'Managed gasless signer custody requires GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY',
    );
  }
}
