import { Interface } from 'ethers';
import { AgroasysEscrow__factory, buildManagedSignerIntentHash } from '@agroasys/sdk';
import { validateSigningRequest } from '../src/signingPolicy';
import { buildSigningRequest, config, relayerWallet, usdcAddress } from './helpers';

function rebind(request: ReturnType<typeof buildSigningRequest>) {
  return {
    ...request,
    intentHash: buildManagedSignerIntentHash({
      requestId: request.requestId,
      signerAddress: request.signerAddress,
      ...request.transaction,
    }),
  };
}

test('accepts an exact authenticated gateway intent', () => {
  expect(validateSigningRequest(buildSigningRequest(), config)).toMatchObject({
    operation: 'finalize_after_dispute_window',
    signerAddress: relayerWallet.address,
    transaction: { chainId: config.chainId, to: config.escrowAddress, value: '0' },
  });
});

test.each([
  [
    'wrong custody',
    (request: ReturnType<typeof buildSigningRequest>) => ({ ...request, custodyMode: 'mpc' }),
  ],
  [
    'wrong signer',
    (request: ReturnType<typeof buildSigningRequest>) =>
      rebind({ ...request, signerAddress: usdcAddress }),
  ],
  [
    'wrong chain',
    (request: ReturnType<typeof buildSigningRequest>) =>
      rebind({ ...request, transaction: { ...request.transaction, chainId: 1 } }),
  ],
  [
    'wrong recipient',
    (request: ReturnType<typeof buildSigningRequest>) =>
      rebind({ ...request, transaction: { ...request.transaction, to: usdcAddress } }),
  ],
  [
    'non-zero value',
    (request: ReturnType<typeof buildSigningRequest>) =>
      rebind({ ...request, transaction: { ...request.transaction, value: '1' } }),
  ],
  [
    'changed nonce',
    (request: ReturnType<typeof buildSigningRequest>) => ({
      ...request,
      transaction: { ...request.transaction, nonce: 8 },
    }),
  ],
  [
    'changed intent hash',
    (request: ReturnType<typeof buildSigningRequest>) => ({
      ...request,
      intentHash: `0x${'0'.repeat(64)}`,
    }),
  ],
  [
    'request ID with surrounding whitespace',
    (request: ReturnType<typeof buildSigningRequest>) => ({
      ...request,
      requestId: ` ${request.requestId}`,
    }),
  ],
  [
    'odd-length calldata',
    (request: ReturnType<typeof buildSigningRequest>) => ({
      ...request,
      transaction: { ...request.transaction, data: `${request.transaction.data}0` },
    }),
  ],
] as const)('rejects %s', (_name, mutate) => {
  expect(() => validateSigningRequest(mutate(buildSigningRequest()), config)).toThrow();
});

test('rejects an operation that does not match the exact calldata selector', () => {
  const data = new Interface(AgroasysEscrow__factory.abi).encodeFunctionData(
    'openDisputeWithAuthorization',
    [`0x${'1'.padStart(64, '0')}`, 1n, 2n, '0x'],
  );
  const request = buildSigningRequest({
    transaction: { ...buildSigningRequest().transaction, data },
  });
  expect(() => validateSigningRequest(rebind(request), config)).toThrow(
    'transaction calldata does not match operation',
  );
});

test('rejects the direct finalization selector even when declared as finalization', () => {
  const data = new Interface(AgroasysEscrow__factory.abi).encodeFunctionData(
    'finalizeAfterDisputeWindow',
    [1n],
  );
  const request = buildSigningRequest({
    transaction: { ...buildSigningRequest().transaction, data },
  });
  expect(() => validateSigningRequest(rebind(request), config)).toThrow(
    'transaction calldata does not match operation',
  );
});

test.each([
  [
    'trade identity substitution',
    (request: ReturnType<typeof buildSigningRequest>) => ({
      ...request,
      policyContext: { ...request.policyContext, tradeId: '2' },
    }),
    'calldata trade ID does not match policy',
  ],
  [
    'authorization nonce substitution',
    (request: ReturnType<typeof buildSigningRequest>) => ({
      ...request,
      policyContext: { ...request.policyContext, authorizationNonce: '9' },
    }),
    'calldata authorization nonce does not match policy',
  ],
  [
    'actor substitution',
    (request: ReturnType<typeof buildSigningRequest>) => ({
      ...request,
      policyContext: { ...request.policyContext, actorAddress: usdcAddress },
    }),
    'calldata authorization signer does not match policy actor',
  ],
] as const)('rejects %s', (_name, mutate, expectedMessage) => {
  expect(() => validateSigningRequest(mutate(buildSigningRequest()), config)).toThrow(
    expectedMessage,
  );
});

test('rejects non-canonical trailing calldata', () => {
  const base = buildSigningRequest();
  const request = rebind({
    ...base,
    transaction: { ...base.transaction, data: `${base.transaction.data}${'00'.repeat(32)}` },
  });
  expect(() => validateSigningRequest(request, config)).toThrow(
    'transaction calldata is not the canonical supported ABI encoding',
  );
});

test('rejects an authorization after its deadline', () => {
  expect(() =>
    validateSigningRequest(buildSigningRequest(), config, new Date('2101-01-01')),
  ).toThrow('calldata authorization is expired');
});

test('rejects fee and gas values outside the reviewed caps', () => {
  const base = buildSigningRequest();
  const highFee = rebind({
    ...base,
    transaction: { ...base.transaction, maxFeePerGasWei: (config.maxFeePerGasWei + 1n).toString() },
  });
  const highGas = rebind({
    ...base,
    transaction: { ...base.transaction, gasLimit: (config.maxGasLimit + 1n).toString() },
  });
  expect(() => validateSigningRequest(highFee, config)).toThrow('transaction fee exceeds');
  expect(() => validateSigningRequest(highGas, config)).toThrow('transaction gas limit exceeds');
});
