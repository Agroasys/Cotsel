import { SigningKey, Transaction, Wallet, getBytes, hexlify } from 'ethers';
import {
  evmAddressFromKmsPublicKey,
  KmsEvmSigner,
  type KmsSigningClient,
} from '../src/kmsEvmSigner';

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  return Uint8Array.of(0x81, length);
}

function derInteger(value: string): Uint8Array {
  let bytes = getBytes(value);
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
  if ((bytes[0] & 0x80) !== 0) bytes = Uint8Array.from([0, ...bytes]);
  return Uint8Array.from([0x02, ...derLength(bytes.length), ...bytes]);
}

function derSignature(digest: Uint8Array): Uint8Array {
  const signature = wallet.signingKey.sign(hexlify(digest));
  const r = derInteger(signature.r);
  const s = derInteger(signature.s);
  return Uint8Array.from([0x30, ...derLength(r.length + s.length), ...r, ...s]);
}

function spkiPublicKey(): Uint8Array {
  const prefix = getBytes('0x3056301006072a8648ce3d020106052b8104000a034200');
  const publicKey = getBytes(SigningKey.computePublicKey(wallet.privateKey, false));
  return Uint8Array.from([...prefix, ...publicKey]);
}

function kmsClient(): KmsSigningClient {
  return {
    getPublicKey: jest.fn(async () => spkiPublicKey()),
    signDigest: jest.fn(async (_keyId, digest) => derSignature(digest)),
  };
}

test('derives the EVM address from an AWS KMS secp256k1 SPKI key', () => {
  expect(evmAddressFromKmsPublicKey(spkiPublicKey())).toBe(wallet.address);
});

test('signs an EIP-1559 transaction without exporting private key material', async () => {
  const signer = new KmsEvmSigner(
    kmsClient(),
    { keyId: 'alias/cotsel-staging-oracle', expectedAddress: wallet.address },
    null as never,
  );
  const signed = await signer.signTransaction({
    chainId: 84532,
    type: 2,
    nonce: 3,
    to: '0x1111111111111111111111111111111111111111',
    value: 0,
    data: '0x1234',
    gasLimit: 100000,
    maxFeePerGas: 2_000_000_000,
    maxPriorityFeePerGas: 1_000_000_000,
  });

  const parsed = Transaction.from(signed);
  expect(parsed.from).toBe(wallet.address);
  expect(parsed.chainId).toBe(84532n);
  expect(parsed.nonce).toBe(3);
});

test('fails closed when the KMS public key has the wrong address', async () => {
  const signer = new KmsEvmSigner(
    kmsClient(),
    {
      keyId: 'alias/cotsel-staging-oracle',
      expectedAddress: '0x1111111111111111111111111111111111111111',
    },
    null as never,
  );
  await expect(signer.getAddress()).rejects.toThrow(/does not match expected/);
});

test('rejects malformed KMS public key and signature values', async () => {
  expect(() => evmAddressFromKmsPublicKey(Uint8Array.of(0x30, 0x00))).toThrow(/truncated/);

  const client = kmsClient();
  client.signDigest = jest.fn(async () => Uint8Array.of(0x30, 0x00));
  const signer = new KmsEvmSigner(
    client,
    { keyId: 'alias/cotsel-staging-oracle', expectedAddress: wallet.address },
    null as never,
  );
  await expect(
    signer.signTransaction({
      chainId: 84532,
      nonce: 0,
      to: '0x1111111111111111111111111111111111111111',
      gasLimit: 21000,
      gasPrice: 1,
    }),
  ).rejects.toThrow(/truncated/);
});
