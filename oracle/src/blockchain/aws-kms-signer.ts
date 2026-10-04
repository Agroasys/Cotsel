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
import { getAddress, getBytes, hashMessage, type Provider } from 'ethers';

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
 * verifies signing permission with a fresh domain-separated challenge. No transaction is created.
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
    const digest = hashMessage(`Cotsel oracle readiness v1:${expectedAddress}:${randomUUID()}`);
    const signature = await client.signDigest(options.keyId, getBytes(digest));
    signatureFromKmsDer(digest, signature, expectedAddress);
  };
}
