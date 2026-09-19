import { SigningKey, Wallet, getBytes } from 'ethers';
import { evmAddressFromKmsPublicKey } from '@agroasys/sdk';
import { expect } from 'chai';
import { independentlyDeriveEvmAddress } from '../scripts/derive-kms-signer-addresses';

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

function spkiPublicKey(): Uint8Array {
  const prefix = getBytes('0x3056301006072a8648ce3d020106052b8104000a034200');
  const point = getBytes(SigningKey.computePublicKey(wallet.privateKey, false));
  return Uint8Array.from([...prefix, ...point]);
}

describe('KMS signer address derivation evidence', () => {
  it('gets the same checksummed address through independent derivations', () => {
    const publicKey = spkiPublicKey();
    expect(evmAddressFromKmsPublicKey(publicKey)).to.equal(wallet.address);
    expect(independentlyDeriveEvmAddress(publicKey)).to.equal(wallet.address);
  });

  it('rejects a malformed SPKI value', () => {
    expect(() => independentlyDeriveEvmAddress(Uint8Array.of(0x30, 0x00))).to.throw(/truncated/);
  });
});
