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
import type { Provider } from 'ethers';

function requiredBytes(value: Uint8Array | undefined, operation: string): Uint8Array {
  if (!value?.length) {
    throw new Error(`AWS KMS ${operation} returned no bytes`);
  }
  return value;
}

export function createAwsKmsOracleSigner(
  options: { keyId: string; expectedAddress: string },
  provider: Provider,
  kms = new KMSClient({}),
): KmsEvmSigner {
  const client: KmsSigningClient = {
    async getPublicKey(keyId) {
      const result = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (
        result.KeySpec !== KeySpec.ECC_SECG_P256K1 ||
        result.KeyUsage !== KeyUsageType.SIGN_VERIFY
      ) {
        throw new Error('Oracle KMS key must be ECC_SECG_P256K1 with SIGN_VERIFY usage');
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

  return new KmsEvmSigner(client, options, provider);
}
