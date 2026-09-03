/**
 * SPDX-License-Identifier: Apache-2.0
 */
export type GaslessSignerCustodyMode = 'raw_private_key' | 'kms' | 'mpc';

export function parseGaslessSignerCustodyMode(value: string | undefined): GaslessSignerCustodyMode {
  const normalized = value?.trim() || 'raw_private_key';
  if (normalized === 'raw_private_key' || normalized === 'kms' || normalized === 'mpc') {
    return normalized;
  }

  throw new Error('GATEWAY_GASLESS_SIGNER_CUSTODY_MODE must be raw_private_key, kms, or mpc');
}
