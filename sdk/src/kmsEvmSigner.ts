import {
  AbstractSigner,
  computeAddress,
  getAddress,
  getBytes,
  hexlify,
  recoverAddress,
  Signature,
  toBeHex,
  Transaction,
  TransactionRequest,
} from 'ethers';
import type { Provider, TransactionLike } from 'ethers';

const SECP256K1_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

export interface KmsSigningClient {
  getPublicKey(keyId: string): Promise<Uint8Array>;
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

export interface KmsEvmSignerOptions {
  keyId: string;
  expectedAddress: string;
}

interface DerElement {
  tag: number;
  value: Uint8Array;
  nextOffset: number;
}

function readDerElement(bytes: Uint8Array, offset: number): DerElement {
  if (offset + 2 > bytes.length) {
    throw new Error('KMS DER value is truncated');
  }

  const tag = bytes[offset];
  const lengthByte = bytes[offset + 1];
  let length = lengthByte;
  let valueOffset = offset + 2;

  if ((lengthByte & 0x80) !== 0) {
    const lengthBytes = lengthByte & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || valueOffset + lengthBytes > bytes.length) {
      throw new Error('KMS DER value has an invalid length');
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[valueOffset + index];
    }
    valueOffset += lengthBytes;
  }

  const nextOffset = valueOffset + length;
  if (nextOffset > bytes.length) {
    throw new Error('KMS DER value length exceeds the payload');
  }

  return { tag, value: bytes.slice(valueOffset, nextOffset), nextOffset };
}

function parseDerInteger(bytes: Uint8Array, name: string): bigint {
  if (bytes.length === 0 || (bytes[0] & 0x80) !== 0) {
    throw new Error(`KMS signature ${name} is not a positive DER integer`);
  }
  const normalized = bytes[0] === 0 ? bytes.slice(1) : bytes;
  if (normalized.length === 0 || normalized.length > 32) {
    throw new Error(`KMS signature ${name} is outside secp256k1`);
  }
  return BigInt(`0x${Buffer.from(normalized).toString('hex')}`);
}

export function evmAddressFromKmsPublicKey(publicKeyDer: Uint8Array): string {
  const outer = readDerElement(publicKeyDer, 0);
  if (outer.tag !== 0x30 || outer.nextOffset !== publicKeyDer.length) {
    throw new Error('KMS public key must be one DER sequence');
  }

  const algorithm = readDerElement(outer.value, 0);
  if (algorithm.tag !== 0x30) {
    throw new Error('KMS public key algorithm metadata is invalid');
  }
  const bitString = readDerElement(outer.value, algorithm.nextOffset);
  if (
    bitString.tag !== 0x03 ||
    bitString.nextOffset !== outer.value.length ||
    bitString.value.length !== 66 ||
    bitString.value[0] !== 0 ||
    bitString.value[1] !== 0x04
  ) {
    throw new Error('KMS public key is not an uncompressed secp256k1 key');
  }

  return getAddress(computeAddress(hexlify(bitString.value.slice(1))));
}

export function signatureFromKmsDer(
  digest: string,
  signatureDer: Uint8Array,
  expectedAddress: string,
): Signature {
  const sequence = readDerElement(signatureDer, 0);
  if (sequence.tag !== 0x30 || sequence.nextOffset !== signatureDer.length) {
    throw new Error('KMS signature must be one DER sequence');
  }

  const rElement = readDerElement(sequence.value, 0);
  const sElement = readDerElement(sequence.value, rElement.nextOffset);
  if (
    rElement.tag !== 0x02 ||
    sElement.tag !== 0x02 ||
    sElement.nextOffset !== sequence.value.length
  ) {
    throw new Error('KMS signature must contain exactly two DER integers');
  }

  const rValue = parseDerInteger(rElement.value, 'r');
  let sValue = parseDerInteger(sElement.value, 's');
  if (rValue <= 0n || rValue >= SECP256K1_ORDER || sValue <= 0n || sValue >= SECP256K1_ORDER) {
    throw new Error('KMS signature is outside the secp256k1 scalar range');
  }
  if (sValue > SECP256K1_HALF_ORDER) {
    sValue = SECP256K1_ORDER - sValue;
  }

  const expected = getAddress(expectedAddress);
  const r = toBeHex(rValue, 32);
  const s = toBeHex(sValue, 32);
  for (const yParity of [0, 1] as const) {
    const signature = Signature.from({ r, s, yParity });
    if (getAddress(recoverAddress(digest, signature)) === expected) {
      return signature;
    }
  }

  throw new Error('KMS signature does not recover to the expected signer address');
}

export class KmsEvmSigner extends AbstractSigner {
  private readonly expectedAddress: string;
  private resolvedAddress?: string;

  constructor(
    private readonly client: KmsSigningClient,
    private readonly options: KmsEvmSignerOptions,
    provider: Provider | null,
  ) {
    super(provider);
    this.expectedAddress = getAddress(options.expectedAddress);
  }

  connect(provider: Provider | null): KmsEvmSigner {
    return new KmsEvmSigner(this.client, this.options, provider);
  }

  async getAddress(): Promise<string> {
    if (this.resolvedAddress) {
      return this.resolvedAddress;
    }
    const publicKey = await this.client.getPublicKey(this.options.keyId);
    const address = evmAddressFromKmsPublicKey(publicKey);
    if (address !== this.expectedAddress) {
      throw new Error(`KMS key address ${address} does not match expected ${this.expectedAddress}`);
    }
    this.resolvedAddress = address;
    return address;
  }

  async signTransaction(transaction: TransactionRequest): Promise<string> {
    const expectedAddress = await this.getAddress();
    const unsigned = Transaction.from(transaction as TransactionLike<string>);
    const digest = unsigned.unsignedHash;
    const signatureDer = await this.client.signDigest(this.options.keyId, getBytes(digest));
    unsigned.signature = signatureFromKmsDer(digest, signatureDer, expectedAddress);
    return unsigned.serialized;
  }

  async signMessage(): Promise<string> {
    throw new Error('KMS transaction signer does not permit message signing');
  }

  async signTypedData(): Promise<string> {
    throw new Error('KMS transaction signer does not permit typed-data signing');
  }
}
