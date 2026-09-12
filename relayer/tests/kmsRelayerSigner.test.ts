import { GetPublicKeyCommand, KeySpec, KeyUsageType, SignCommand } from '@aws-sdk/client-kms';
import { getBytes, hexlify, SigningKey, Transaction } from 'ethers';
import { createKmsRelayerSigner } from '../src/kmsRelayerSigner';
import { buildSigningRequest, config, relayerWallet } from './helpers';

function derLength(length: number): Uint8Array {
  return length < 0x80 ? Uint8Array.of(length) : Uint8Array.of(0x81, length);
}

function derInteger(value: string): Uint8Array {
  let bytes = getBytes(value);
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
  if ((bytes[0] & 0x80) !== 0) bytes = Uint8Array.from([0, ...bytes]);
  return Uint8Array.from([0x02, ...derLength(bytes.length), ...bytes]);
}

function derSignature(digest: Uint8Array): Uint8Array {
  const signature = relayerWallet.signingKey.sign(hexlify(digest));
  const r = derInteger(signature.r);
  const s = derInteger(signature.s);
  return Uint8Array.from([0x30, ...derLength(r.length + s.length), ...r, ...s]);
}

function spkiPublicKey(): Uint8Array {
  const prefix = getBytes('0x3056301006072a8648ce3d020106052b8104000a034200');
  const publicKey = getBytes(SigningKey.computePublicKey(relayerWallet.privateKey, false));
  return Uint8Array.from([...prefix, ...publicKey]);
}

test('uses only the configured secp256k1 KMS identity to sign the approved transaction', async () => {
  const send = jest.fn(async (command: GetPublicKeyCommand | SignCommand) => {
    if (command instanceof GetPublicKeyCommand) {
      return {
        KeySpec: KeySpec.ECC_SECG_P256K1,
        KeyUsage: KeyUsageType.SIGN_VERIFY,
        PublicKey: spkiPublicKey(),
      };
    }
    return { Signature: derSignature(command.input.Message!) };
  });
  const signer = createKmsRelayerSigner(config, { send } as never);
  const signed = await signer.signTransaction(buildSigningRequest());
  const transaction = Transaction.from(signed);

  expect(transaction.from).toBe(relayerWallet.address);
  expect(transaction.chainId).toBe(BigInt(config.chainId));
  expect(send).toHaveBeenCalledTimes(2);
  expect((send.mock.calls[0][0] as GetPublicKeyCommand).input.KeyId).toBe(config.kmsKeyId);
  expect((send.mock.calls[1][0] as SignCommand).input.KeyId).toBe(config.kmsKeyId);
});

test('rejects a KMS identity with the wrong key specification', async () => {
  const send = jest.fn(async () => ({
    KeySpec: KeySpec.RSA_2048,
    KeyUsage: KeyUsageType.SIGN_VERIFY,
    PublicKey: spkiPublicKey(),
  }));
  const signer = createKmsRelayerSigner(config, { send } as never);
  await expect(signer.getAddress()).rejects.toThrow(
    'Relayer KMS key must be ECC_SECG_P256K1 with SIGN_VERIFY usage',
  );
});
