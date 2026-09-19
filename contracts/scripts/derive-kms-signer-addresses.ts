// SPDX-License-Identifier: Apache-2.0
import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  KeySpec,
  KeyUsageType,
  SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import { evmAddressFromKmsPublicKey } from '@agroasys/sdk';
import { getAddress, hexlify, keccak256 } from 'ethers';
import { createHash } from 'node:crypto';

interface DerElement {
  tag: number;
  value: Uint8Array;
  nextOffset: number;
}

export function readDerElement(bytes: Uint8Array, offset: number): DerElement {
  if (offset + 2 > bytes.length) throw new Error('SPKI value is truncated');

  const tag = bytes[offset];
  const lengthByte = bytes[offset + 1];
  let length = lengthByte;
  let valueOffset = offset + 2;

  if ((lengthByte & 0x80) !== 0) {
    const lengthBytes = lengthByte & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || valueOffset + lengthBytes > bytes.length) {
      throw new Error('SPKI value has an invalid length');
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[valueOffset + index];
    }
    valueOffset += lengthBytes;
  }

  const nextOffset = valueOffset + length;
  if (nextOffset > bytes.length) throw new Error('SPKI value length exceeds the payload');
  return { tag, value: bytes.slice(valueOffset, nextOffset), nextOffset };
}

export function independentlyDeriveEvmAddress(publicKeyDer: Uint8Array): string {
  const sequence = readDerElement(publicKeyDer, 0);
  if (sequence.tag !== 0x30 || sequence.nextOffset !== publicKeyDer.length) {
    throw new Error('KMS public key must be one SPKI sequence');
  }

  const algorithm = readDerElement(sequence.value, 0);
  const point = readDerElement(sequence.value, algorithm.nextOffset);
  if (
    algorithm.tag !== 0x30 ||
    point.tag !== 0x03 ||
    point.nextOffset !== sequence.value.length ||
    point.value.length !== 66 ||
    point.value[0] !== 0 ||
    point.value[1] !== 0x04
  ) {
    throw new Error('KMS public key is not an uncompressed secp256k1 point');
  }

  const digest = keccak256(hexlify(point.value.slice(2)));
  return getAddress(`0x${digest.slice(-40)}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const aliases = process.argv.slice(2);
  if (aliases.length !== 2 || new Set(aliases).size !== 2) {
    throw new Error('Provide exactly two distinct reviewed KMS aliases');
  }

  const kms = new KMSClient({});
  const signers = [];

  for (const alias of aliases) {
    const [publicKey, description] = await Promise.all([
      kms.send(new GetPublicKeyCommand({ KeyId: alias })),
      kms.send(new DescribeKeyCommand({ KeyId: alias })),
    ]);
    if (
      publicKey.KeySpec !== KeySpec.ECC_SECG_P256K1 ||
      publicKey.KeyUsage !== KeyUsageType.SIGN_VERIFY
    ) {
      throw new Error(`${alias} must be ECC_SECG_P256K1 with SIGN_VERIFY usage`);
    }
    if (!publicKey.SigningAlgorithms?.includes(SigningAlgorithmSpec.ECDSA_SHA_256)) {
      throw new Error(`${alias} must support ECDSA_SHA_256`);
    }
    if (!publicKey.PublicKey?.length) throw new Error(`${alias} returned no public key`);
    if (!description.KeyMetadata?.Arn || !description.KeyMetadata.KeyId) {
      throw new Error(`${alias} returned incomplete key metadata`);
    }

    const sdkAddress = evmAddressFromKmsPublicKey(publicKey.PublicKey);
    const independentAddress = independentlyDeriveEvmAddress(publicKey.PublicKey);
    if (sdkAddress !== independentAddress) {
      throw new Error(`${alias} derivations disagree: ${sdkAddress} != ${independentAddress}`);
    }

    signers.push({
      alias,
      keyArn: description.KeyMetadata.Arn,
      keyId: description.KeyMetadata.KeyId,
      keySpec: publicKey.KeySpec,
      keyUsage: publicKey.KeyUsage,
      signingAlgorithms: publicKey.SigningAlgorithms,
      publicKeySha256: createHash('sha256').update(publicKey.PublicKey).digest('hex'),
      derivations: {
        sdkSpkiComputeAddress: sdkAddress,
        independentSpkiKeccak256: independentAddress,
      },
      verifiedAddress: sdkAddress,
    });
  }

  if (new Set(signers.map(({ verifiedAddress }) => verifiedAddress)).size !== signers.length) {
    throw new Error('The Oracle and relayer KMS addresses must differ');
  }

  const evidence = {
    schemaVersion: 1,
    evidenceType: 'kms-public-key-address-derivation',
    environment: 'staging',
    awsAccountId: '655177116834',
    awsRegion: requiredEnv('AWS_REGION'),
    sourceCommit: requiredEnv('GITHUB_SHA'),
    repository: requiredEnv('GITHUB_REPOSITORY'),
    workflow: requiredEnv('GITHUB_WORKFLOW'),
    workflowRunId: requiredEnv('GITHUB_RUN_ID'),
    workflowRunAttempt: requiredEnv('GITHUB_RUN_ATTEMPT'),
    ref: requiredEnv('GITHUB_REF'),
    producer: requiredEnv('GITHUB_ACTOR'),
    associatedIssue: 'Agroasys/Cotsel#649',
    generatedAt: new Date().toISOString(),
    signers,
  };

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
