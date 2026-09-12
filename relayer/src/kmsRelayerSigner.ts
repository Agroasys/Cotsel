import {
  GetPublicKeyCommand,
  KMSClient,
  KeySpec,
  KeyUsageType,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import { KmsEvmSigner, type KmsSigningClient } from '@agroasys/sdk';
import type { RelayerConfig } from './config';
import type { RelayerSigningRequest } from './signingPolicy';

export interface RelayerSigner {
  getAddress(): Promise<string>;
  signTransaction(request: RelayerSigningRequest): Promise<string>;
}

function requiredBytes(value: Uint8Array | undefined, operation: string): Uint8Array {
  if (!value?.length) throw new Error(`AWS KMS ${operation} returned no bytes`);
  return value;
}

export function createKmsRelayerSigner(
  config: RelayerConfig,
  kms = new KMSClient({}),
): RelayerSigner {
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

  return {
    getAddress: () => signer.getAddress(),
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
