/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GatewayConfig } from '../config/env';

export type GaslessExecutorConfig = Pick<
  GatewayConfig,
  | 'rpcUrl'
  | 'rpcFallbackUrls'
  | 'rpcQuorum'
  | 'chainId'
  | 'escrowAddress'
  | 'usdcAddress'
  | 'gaslessExecutorPrivateKey'
  | 'gaslessSignerCustodyMode'
  | 'gaslessKmsKeyId'
  | 'gaslessKmsExpectedAddress'
  | 'gaslessManagedSignerUrl'
  | 'gaslessManagedSignerApiKey'
  | 'gaslessManagedSignerApiSecret'
  | 'gaslessManagedSignerRequestTimeoutMs'
  | 'gaslessMaxGasLimit'
  | 'gaslessMaxFeePerGasWei'
  | 'gaslessMaxNativeCostWei'
  | 'gaslessMinExecutorBalanceWei'
  | 'gaslessReceiptTimeoutMs'
>;
