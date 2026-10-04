import {
  GetPublicKeyCommand,
  KMSClient,
  KeySpec,
  KeyUsageType,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import {
  evmAddressFromKmsPublicKey,
  KmsEvmSigner,
  signatureFromKmsDer,
  type KmsSigningClient,
} from '@agroasys/sdk';
import { randomUUID } from 'node:crypto';
import { getAddress, getBytes, hashMessage } from 'ethers';
import type { RelayerConfig } from './config';
import type { RelayerSigningRequest } from './signingPolicy';

export interface RelayerSigner {
  getAddress(): Promise<string>;
  signTransaction(request: RelayerSigningRequest): Promise<string>;
}

export interface KmsRelayerSigner extends RelayerSigner {
  /**
   * Readiness probe: reads the key from KMS now (the signer caches its address after startup)
   * and refuses a key that is unreachable, disabled, or no longer the reviewed one.
   */
  checkReadiness(): Promise<void>;
}

function requiredBytes(value: Uint8Array | undefined, operation: string): Uint8Array {
  if (!value?.length) throw new Error(`AWS KMS ${operation} returned no bytes`);
  return value;
}

export function createKmsRelayerSigner(
  config: RelayerConfig,
  kms = new KMSClient({}),
): KmsRelayerSigner {
  const client: KmsSigningClient = {
    async getPublicKey(keyId) {
      const result = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (
        result.KeySpec !== KeySpec.ECC_SECG_P256K1 ||
        result.KeyUsage !== KeyUsageType.SIGN_VERIFY
      ) {
        throw new Error('Relayer KMS key must be ECC_SECG_P256K1 with SIGN_VERIFY usage');
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
    { keyId: config.kmsKeyId, expectedAddress: config.kmsExpectedAddress },
    null,
  );

  const expectedAddress = getAddress(config.kmsExpectedAddress);

  return {
    getAddress: () => signer.getAddress(),
    async checkReadiness() {
      const address = evmAddressFromKmsPublicKey(await client.getPublicKey(config.kmsKeyId));
      if (address !== expectedAddress) {
        throw new Error('Relayer KMS key no longer matches the reviewed signer address');
      }
      const digest = hashMessage(`Cotsel relayer readiness v1:${expectedAddress}:${randomUUID()}`);
      const signature = await client.signDigest(config.kmsKeyId, getBytes(digest));
      signatureFromKmsDer(digest, signature, expectedAddress);
    },
    async signTransaction(request) {
      const transaction = request.transaction;
      return signer.signTransaction({
        chainId: transaction.chainId,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
        nonce: transaction.nonce,
        gasLimit: transaction.gasLimit,
        type: transaction.type,
        ...(transaction.type === 2
          ? {
              maxFeePerGas: transaction.maxFeePerGasWei,
              maxPriorityFeePerGas: transaction.maxPriorityFeePerGasWei,
            }
          : { gasPrice: transaction.gasPriceWei }),
      });
    },
  };
}
