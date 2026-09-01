/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, isAddress } from 'ethers';
import type { ManagedSignerResponsePayload } from '@agroasys/sdk';
import { GatewayError } from '../errors';
import type { GaslessExecutorConfig } from './gaslessExecutorConfig';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessOperatorAction,
  GaslessUserAction,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';
import type { ManagedSignerRequestTransaction } from './managedSignerIntentValidation';

export type ManagedSignerGaslessConfig = GaslessExecutorConfig;

export interface ManagedSignerRequest {
  custodyMode: 'kms' | 'mpc';
  operation:
    | GaslessCreateTradeExecutionInput['action']
    | GaslessUserAction
    | GaslessOperatorAction
    | GaslessWalletUsdcTransferExecutionInput['action'];
  signerAddress: string;
  requestId: string;
  intentHash: string;
  transaction: ManagedSignerRequestTransaction;
}

export interface ManagedSignerTransport {
  getSignerAddress(): Promise<string>;
  signTransaction(request: ManagedSignerRequest): Promise<ManagedSignerResponsePayload>;
}

export function createHttpManagedSignerTransport(
  config: ManagedSignerGaslessConfig,
): ManagedSignerTransport {
  if (!config.gaslessManagedSignerUrl) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless managed signer URL is not configured',
    );
  }

  const signerUrl = `${config.gaslessManagedSignerUrl}/api/signers/gasless-relayer/sign-transaction`;
  const signerAddressUrl = `${config.gaslessManagedSignerUrl}/api/signers/gasless-relayer/address`;
  const requestTimeoutMs = config.gaslessManagedSignerRequestTimeoutMs ?? 5000;
  const headers = {
    Accept: 'application/json',
    ...(config.gaslessManagedSignerApiKey
      ? { Authorization: `Bearer ${config.gaslessManagedSignerApiKey}` }
      : {}),
  };

  return {
    async getSignerAddress() {
      const response = await fetch(signerAddressUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        throw new GatewayError(
          response.status >= 500 ? 503 : 502,
          'UPSTREAM_UNAVAILABLE',
          'Gasless managed signer address lookup failed',
          { signerStatus: response.status },
        );
      }
      const payload = (await response.json()) as { signerAddress?: unknown };
      if (!isAddress(String(payload.signerAddress))) {
        throw new GatewayError(
          502,
          'UPSTREAM_UNAVAILABLE',
          'Gasless managed signer returned an invalid address',
        );
      }
      return getAddress(String(payload.signerAddress));
    },

    async signTransaction(request) {
      const response = await fetch(signerUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (!response.ok) {
        throw new GatewayError(
          response.status >= 500 ? 503 : 502,
          'UPSTREAM_UNAVAILABLE',
          'Gasless managed signer rejected transaction signing request',
          {
            signerStatus: response.status,
            custodyMode: request.custodyMode,
            operation: request.operation,
          },
        );
      }

      return (await response.json()) as ManagedSignerResponsePayload;
    },
  };
}
