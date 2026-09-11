// SPDX-License-Identifier: Apache-2.0
import { GetPublicKeyCommand, KMSClient, KeySpec, KeyUsageType } from '@aws-sdk/client-kms';
import { evmAddressFromKmsPublicKey } from '@agroasys/sdk';
import { getAddress, isAddress } from 'ethers';

interface RoleInput {
  role: string;
  keyId: string;
  expectedAddress: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseAddress(name: string, value: string): string {
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return getAddress(value);
}

function roleInputs(): RoleInput[] {
  return [
    {
      role: 'oracle',
      keyId: 'alias/cotsel-staging-oracle-signer',
      expectedAddress: parseAddress('DEPLOY_ORACLE_ADDRESS', requiredEnv('DEPLOY_ORACLE_ADDRESS')),
    },
    {
      role: 'relayer',
      keyId: 'alias/cotsel-staging-relayer-signer',
      expectedAddress: parseAddress(
        'DEPLOY_RELAYER_ADDRESS',
        requiredEnv('DEPLOY_RELAYER_ADDRESS'),
      ),
    },
  ];
}

async function main(): Promise<void> {
  const inputs = roleInputs();
  const expectedAddresses = inputs.map(({ expectedAddress }) => expectedAddress.toLowerCase());
  if (new Set(expectedAddresses).size !== expectedAddresses.length) {
    throw new Error('The Oracle and relayer KMS addresses must differ');
  }

  const kms = new KMSClient({});
  const roles = [];
  for (const input of inputs) {
    const response = await kms.send(new GetPublicKeyCommand({ KeyId: input.keyId }));
    if (
      response.KeySpec !== KeySpec.ECC_SECG_P256K1 ||
      response.KeyUsage !== KeyUsageType.SIGN_VERIFY
    ) {
      throw new Error(`${input.role} KMS key must be ECC_SECG_P256K1 with SIGN_VERIFY usage`);
    }
    if (!response.PublicKey?.length) {
      throw new Error(`${input.role} KMS key returned no public key`);
    }

    const observedAddress = evmAddressFromKmsPublicKey(response.PublicKey);
    if (observedAddress !== input.expectedAddress) {
      throw new Error(
        `${input.role} KMS address ${observedAddress} does not match reviewed ${input.expectedAddress}`,
      );
    }
    roles.push({
      role: input.role,
      keyId: input.keyId,
      resolvedKeyId: response.KeyId ?? null,
      expectedAddress: input.expectedAddress,
      observedAddress,
    });
  }

  process.stdout.write(
    `${JSON.stringify({ generatedAt: new Date().toISOString(), roles }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
