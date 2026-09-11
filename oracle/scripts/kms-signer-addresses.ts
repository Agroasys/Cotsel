import { GetPublicKeyCommand, KMSClient, KeySpec, KeyUsageType } from '@aws-sdk/client-kms';
import { evmAddressFromKmsPublicKey } from '@agroasys/sdk';

const keyIds = process.argv.slice(2);
if (keyIds.length === 0) {
  throw new Error('Provide one or more reviewed KMS key IDs or aliases');
}

async function main(): Promise<void> {
  const kms = new KMSClient({});
  const results = [];

  for (const keyId of keyIds) {
    const response = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (
      response.KeySpec !== KeySpec.ECC_SECG_P256K1 ||
      response.KeyUsage !== KeyUsageType.SIGN_VERIFY
    ) {
      throw new Error(`${keyId} must be ECC_SECG_P256K1 with SIGN_VERIFY usage`);
    }
    if (!response.PublicKey?.length) {
      throw new Error(`${keyId} returned no public key`);
    }
    results.push({
      keyId,
      keyArn: response.KeyId,
      address: evmAddressFromKmsPublicKey(response.PublicKey),
    });
  }

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
