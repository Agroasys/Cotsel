/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { getAddress, isAddress } from 'ethers';
import type { ManagedSignerPolicyContext, ManagedSignerResponsePayload } from '@agroasys/sdk';
import { GatewayError } from '../errors';
import type { GaslessExecutorConfig } from './gaslessExecutorConfig';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessUserAction,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';
import type { ManagedSignerRequestTransaction } from './managedSignerIntentValidation';
import { createServiceAuthHeaders } from './serviceAuth';

export type ManagedSignerGaslessConfig = GaslessExecutorConfig;

export interface ManagedSignerRequest {
  custodyMode: 'kms' | 'mpc';
  operation:
    | GaslessCreateTradeExecutionInput['action']
    | GaslessUserAction
    | GaslessWalletUsdcTransferExecutionInput['action'];
  signerAddress: string;
  requestId: string;
  intentHash: string;
  transaction: ManagedSignerRequestTransaction;
  policyContext: ManagedSignerPolicyContext;
}

export interface ManagedSignerTransport {
  getSignerAddress(): Promise<string>;
  signTransaction(request: ManagedSignerRequest): Promise<ManagedSignerResponsePayload>;
}

export function createManagedSignerTransport(
  config: ManagedSignerGaslessConfig,
): ManagedSignerTransport {
  return createHttpManagedSignerTransport(config);
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

  const signerPath = '/api/signers/gasless-relayer/sign-transaction';
  const signerAddressPath = '/api/signers/gasless-relayer/address';
  const signerUrl = `${config.gaslessManagedSignerUrl}${signerPath}`;
  const signerAddressUrl = `${config.gaslessManagedSignerUrl}${signerAddressPath}`;
  const requestTimeoutMs = config.gaslessManagedSignerRequestTimeoutMs ?? 5000;

  function authHeaders(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
  ): Record<string, string> {
    if (config.gaslessManagedSignerApiKey && config.gaslessManagedSignerApiSecret) {
      return {
        ...createServiceAuthHeaders({
          apiKey: config.gaslessManagedSignerApiKey,
          apiSecret: config.gaslessManagedSignerApiSecret,
          method,
          path,
          body,
        }),
      };
    }
    if (config.gaslessManagedSignerApiKey) {
      return { Authorization: `Bearer ${config.gaslessManagedSignerApiKey}` };
    }
    return {};
  }

  return {
    async getSignerAddress() {
      const response = await fetch(signerAddressUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', ...authHeaders('GET', signerAddressPath) },
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
      const body = JSON.stringify(request);
      const response = await fetch(signerUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'content-type': 'application/json',
          ...authHeaders('POST', signerPath, body),
        },
        body,
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
