import { Wallet } from 'ethers';
import {
  buildManagedSignerIntentHash,
  ManagedSignerValidationError,
  ManagedSignerTransactionIntent,
  validateManagedSignerTransaction,
} from '../src/managedSignerIntent';

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const recipient = '0x00000000000000000000000000000000000000A1';

function intent(
  overrides: Partial<ManagedSignerTransactionIntent> = {},
): ManagedSignerTransactionIntent {
  return {
    requestId: 'signer-request-1',
    signerAddress: wallet.address,
    chainId: 84532,
    to: recipient,
    data: '0x12345678',
    value: '0',
    nonce: 7,
    gasLimit: '210000',
    type: 2,
    maxFeePerGasWei: '1000000000',
    maxPriorityFeePerGasWei: '100000000',
    ...overrides,
  };
}

async function sign(candidate: ManagedSignerTransactionIntent): Promise<string> {
  return wallet.signTransaction({
    chainId: candidate.chainId,
    to: candidate.to,
    data: candidate.data,
    value: BigInt(candidate.value),
    nonce: candidate.nonce,
    gasLimit: BigInt(candidate.gasLimit),
    type: candidate.type,
    ...(candidate.type === 2
      ? {
          maxFeePerGas: BigInt(candidate.maxFeePerGasWei!),
          maxPriorityFeePerGas: BigInt(candidate.maxPriorityFeePerGasWei!),
        }
      : { gasPrice: BigInt(candidate.gasPriceWei!) }),
  });
}

test('accepts the exact signed transaction and produces privacy-safe audit hashes', async () => {
  const approved = intent();
  const signed = await sign(approved);
  const evidence = validateManagedSignerTransaction(signed, approved);

  expect(evidence).toEqual({
    requestId: approved.requestId,
    intentHash: buildManagedSignerIntentHash(approved),
    signedTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    signerAddress: wallet.address,
    nonce: 7,
    transactionType: 2,
  });
});

test.each([
  ['recipient', { to: '0x00000000000000000000000000000000000000B2' }],
  ['chainId', { chainId: 1 }],
  ['nonce', { nonce: 8 }],
  ['value', { value: '1' }],
  ['calldata', { data: '0x12345679' }],
  ['gasLimit', { gasLimit: '210001' }],
  ['maxFeePerGas', { maxFeePerGasWei: '1000000001' }],
  ['maxPriorityFeePerGas', { maxPriorityFeePerGasWei: '100000001' }],
] as const)('rejects a signer mutation of %s', async (field, mutation) => {
  const approved = intent();
  const signed = await sign(intent(mutation));
  try {
    validateManagedSignerTransaction(signed, approved);
    throw new Error('Expected managed signer validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedSignerValidationError);
    expect(error).toMatchObject({
      reason: field,
      requestId: approved.requestId,
      intentHash: buildManagedSignerIntentHash(approved),
      signedTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  }
});

test('rejects a transaction signed by the wrong signer', async () => {
  const approved = intent();
  const wrongSigner = Wallet.createRandom();
  const signed = await wrongSigner.signTransaction({
    chainId: approved.chainId,
    to: approved.to,
    data: approved.data,
    value: BigInt(approved.value),
    nonce: approved.nonce,
    gasLimit: BigInt(approved.gasLimit),
    type: 2,
    maxFeePerGas: BigInt(approved.maxFeePerGasWei!),
    maxPriorityFeePerGas: BigInt(approved.maxPriorityFeePerGasWei!),
  });
  expect(() => validateManagedSignerTransaction(signed, approved)).toThrow('signer');
});

test('rejects transaction type and access-list mutations', async () => {
  const approved = intent();
  const legacy = intent({
    type: 0,
    maxFeePerGasWei: undefined,
    maxPriorityFeePerGasWei: undefined,
    gasPriceWei: '1000000000',
  });
  const legacySigned = await sign(legacy);
  expect(() => validateManagedSignerTransaction(legacySigned, approved)).toThrow('type');

  const withAccessList = await wallet.signTransaction({
    chainId: approved.chainId,
    to: approved.to,
    data: approved.data,
    value: 0n,
    nonce: approved.nonce,
    gasLimit: BigInt(approved.gasLimit),
    type: 2,
    maxFeePerGas: BigInt(approved.maxFeePerGasWei!),
    maxPriorityFeePerGas: BigInt(approved.maxPriorityFeePerGasWei!),
    accessList: [{ address: recipient, storageKeys: [] }],
  });
  expect(() => validateManagedSignerTransaction(withAccessList, approved)).toThrow('accessList');
});

test('rejects invalid fee-mode combinations before signer dispatch', () => {
  expect(() =>
    buildManagedSignerIntentHash(
      intent({
        type: 0,
        maxFeePerGasWei: undefined,
        maxPriorityFeePerGasWei: undefined,
        gasPriceWei: undefined,
      }),
    ),
  ).toThrow('gasPriceWei');
  expect(() => buildManagedSignerIntentHash(intent({ gasPriceWei: '1' }))).toThrow('gasPriceWei');
});
