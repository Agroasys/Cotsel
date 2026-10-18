/** SPDX-License-Identifier: Apache-2.0 */
import type { GaslessTransactionIdentity } from '../gaslessTransactionOutcomeStore';
import { deny } from './validation';
export const IDENTITY_FIELDS = [
  'transactionHash',
  'applicationRequestId',
  'resourceType',
  'resourceId',
  'operation',
  'chainId',
  'signerAddress',
  'nonce',
  'transactionType',
  'destinationAddress',
  'valueWei',
  'gasLimit',
  'maxFeePerGasWei',
  'maxPriorityFeePerGasWei',
  'gasPriceWei',
  'calldataHash',
  'intentHash',
  'sourceApiKeyId',
] as const;
export function validateSignedIdentity(identity: GaslessTransactionIdentity): void {
  if (
    Object.keys(identity).some((key) => !(IDENTITY_FIELDS as readonly string[]).includes(key)) ||
    IDENTITY_FIELDS.some((key) => !(key in identity))
  )
    deny('Complete canonical signed identity is required');
  for (const key of ['transactionHash', 'calldataHash', 'intentHash'] as const)
    if (!/^0x[0-9a-f]{64}$/.test(identity[key])) deny('Signed hash is invalid');
  for (const key of ['signerAddress', 'destinationAddress'] as const)
    if (!/^0x[0-9a-fA-F]{40}$/.test(identity[key])) deny('Signed address is invalid');
  if (
    !Number.isSafeInteger(identity.chainId) ||
    identity.chainId < 1 ||
    !Number.isSafeInteger(identity.nonce) ||
    identity.nonce < 0 ||
    ![0, 2].includes(identity.transactionType)
  )
    deny('Signed transaction identity is invalid');
  for (const key of ['valueWei', 'gasLimit'] as const)
    if (!/^(0|[1-9]\d*)$/.test(identity[key])) deny('Signed amount is invalid');
  for (const key of ['maxFeePerGasWei', 'maxPriorityFeePerGasWei', 'gasPriceWei'] as const)
    if (
      identity[key] !== null &&
      (typeof identity[key] !== 'string' || !/^(0|[1-9]\d*)$/.test(identity[key]))
    )
      deny('Signed fee is invalid');
  if (
    BigInt(identity.gasLimit) <= 0n ||
    (identity.transactionType === 2
      ? identity.maxFeePerGasWei === null ||
        identity.maxPriorityFeePerGasWei === null ||
        identity.gasPriceWei !== null
      : identity.gasPriceWei === null ||
        identity.maxFeePerGasWei !== null ||
        identity.maxPriorityFeePerGasWei !== null)
  )
    deny('Signed fee fields do not match transaction type');
}
