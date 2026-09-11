/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  GetPublicKeyCommand,
  KMSClient,
  KeySpec,
  KeyUsageType,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import { getAddress, isAddress } from 'ethers';
import { KmsEvmSigner } from '@agroasys/sdk';
import type { KmsSigningClient, ManagedSignerResponsePayload } from '@agroasys/sdk';
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

function requiredBytes(value: Uint8Array | undefined, operation: string): Uint8Array {
  if (!value?.length) {
    throw new GatewayError(503, 'UPSTREAM_UNAVAILABLE', `AWS KMS ${operation} returned no bytes`);
  }
  return value;
}

export function createAwsKmsManagedSignerTransport(
  config: ManagedSignerGaslessConfig,
  kms = new KMSClient({}),
): ManagedSignerTransport {
  if (!config.gaslessKmsKeyId || !config.gaslessKmsExpectedAddress) {
    throw new GatewayError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Gasless AWS KMS identity is not configured',
    );
  }

  const client: KmsSigningClient = {
    async getPublicKey(keyId) {
      const result = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (
        result.KeySpec !== KeySpec.ECC_SECG_P256K1 ||
        result.KeyUsage !== KeyUsageType.SIGN_VERIFY
      ) {
        throw new GatewayError(
          503,
          'UPSTREAM_UNAVAILABLE',
          'Gasless KMS key must be ECC_SECG_P256K1 with SIGN_VERIFY usage',
        );
      }
      return requiredBytes(result.PublicKey, 'GetPublicKey');
    },
    async signDigest(keyId, digest) {
      const result = await kms.send(
        new SignCommand({
          KeyId: keyId,
          Message: digest,
          MessageType: MessageType.DIGEST,
          SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
        }),
      );
      return requiredBytes(result.Signature, 'Sign');
    },
  };
  const signer = new KmsEvmSigner(
    client,
    { keyId: config.gaslessKmsKeyId, expectedAddress: config.gaslessKmsExpectedAddress },
    null,
  );

  return {
    getSignerAddress: () => signer.getAddress(),
    async signTransaction(request) {
      const signedTransaction = await signer.signTransaction({
        chainId: request.transaction.chainId,
        to: request.transaction.to,
        data: request.transaction.data,
        value: request.transaction.value,
        nonce: request.transaction.nonce,
        gasLimit: request.transaction.gasLimit,
        type: request.transaction.type,
        ...(request.transaction.type === 2
          ? {
              maxFeePerGas: request.transaction.maxFeePerGasWei,
              maxPriorityFeePerGas: request.transaction.maxPriorityFeePerGasWei,
            }
          : { gasPrice: request.transaction.gasPriceWei }),
      });
      return {
        requestId: request.requestId,
        intentHash: request.intentHash,
        signerAddress: await signer.getAddress(),
        signedTransaction,
      };
    },
  };
}

export function createManagedSignerTransport(
  config: ManagedSignerGaslessConfig,
): ManagedSignerTransport {
  return config.gaslessSignerCustodyMode === 'kms'
    ? createAwsKmsManagedSignerTransport(config)
    : createHttpManagedSignerTransport(config);
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
