import {
  GetPublicKeyCommand,
  KMSClient,
  KeySpec,
  KeyUsageType,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import { evmAddressFromKmsPublicKey, KmsEvmSigner, type KmsSigningClient } from '@agroasys/sdk';
import { getAddress, type Provider } from 'ethers';

function requiredBytes(value: Uint8Array | undefined, operation: string): Uint8Array {
  if (!value?.length) {
    throw new Error(`AWS KMS ${operation} returned no bytes`);
  }
  return value;
}

export function createAwsKmsSigningClient(kms = new KMSClient({})): KmsSigningClient {
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

  return client;
}

export function createAwsKmsOracleSigner(
  options: { keyId: string; expectedAddress: string },
  provider: Provider,
  client: KmsSigningClient = createAwsKmsSigningClient(),
): KmsEvmSigner {
  return new KmsEvmSigner(client, options, provider);
}

/**
 * Readiness probe: reads the key from KMS now (the signer caches its address after startup) and
 * refuses a key that is unreachable, disabled, of the wrong type, or no longer the reviewed one.
 */
export function createAwsKmsOracleKeyProbe(
  options: { keyId: string; expectedAddress: string },
  client: KmsSigningClient,
): () => Promise<void> {
  const expectedAddress = getAddress(options.expectedAddress);
  return async () => {
    const address = evmAddressFromKmsPublicKey(await client.getPublicKey(options.keyId));
    if (address !== expectedAddress) {
      throw new Error('Oracle KMS key no longer matches the reviewed signer address');
    }
  };
}
