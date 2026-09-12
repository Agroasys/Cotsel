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
  managedSignerApiSecret?: string;
}

function isSecureManagedSignerUrl(value: string): boolean {
  if (value.startsWith('https://')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname.endsWith('.internal');
  } catch {
    return false;
  }
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
      !config.kmsKeyId,
      'GATEWAY_GASLESS_KMS_KEY_ID must not be set; only the dedicated relayer may know the KMS key ID',
    );
    assert(
      config.kmsExpectedAddress && isAddress(config.kmsExpectedAddress),
      'GATEWAY_GASLESS_KMS_EXPECTED_ADDRESS must be a valid EVM address when GATEWAY_GASLESS_SIGNER_CUSTODY_MODE is kms',
    );
    assert(
      config.managedSignerUrl && isSecureManagedSignerUrl(config.managedSignerUrl),
      'KMS custody requires an HTTPS or private .internal GATEWAY_GASLESS_MANAGED_SIGNER_URL',
    );
    assert(
      Boolean(config.managedSignerApiKey && config.managedSignerApiSecret),
      'KMS custody requires GATEWAY_GASLESS_MANAGED_SIGNER_API_KEY and GATEWAY_GASLESS_MANAGED_SIGNER_API_SECRET',
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
