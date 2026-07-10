import { ethers } from 'ethers';
import { ManagedSigner } from './managed-signer';

// Well-known Hardhat account #1; its address is SIGNER_ADDRESS.
const SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SIGNER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// AbstractSigner requires a provider reference but the managed signer only reaches it
// for gas/nonce/broadcast, none of which these unit tests exercise.
const provider = {} as ethers.Provider;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('ManagedSigner', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  test('resolves the signer address from the address endpoint and caches it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ signerAddress: SIGNER_ADDRESS }));
    const signer = new ManagedSigner(
      { url: 'https://signer.internal/', custodyMode: 'kms', apiKey: 'token' },
      provider,
    );

    expect(await signer.getAddress()).toBe(SIGNER_ADDRESS);
    expect(await signer.getAddress()).toBe(SIGNER_ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://signer.internal/api/signers/oracle/address');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  test('delegates transaction signing and returns the signed payload', async () => {
    const request = {
      chainId: 84532,
      to: OTHER_ADDRESS,
      data: '0xabcd',
      value: 0n,
      nonce: 7,
      gasLimit: 100000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    };
    const signedTransaction = await new ethers.Wallet(SIGNER_PRIVATE_KEY).signTransaction(request);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS, signedTransaction }));
    const signer = new ManagedSigner(
      { url: 'https://signer.internal', custodyMode: 'kms' },
      provider,
    );

    const signed = await signer.signTransaction(request);

    expect(signed).toBe(signedTransaction);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://signer.internal/api/signers/oracle/sign-transaction');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      custodyMode: 'kms',
      operation: 'oracle_settlement',
      signerAddress: SIGNER_ADDRESS,
      transaction: {
        chainId: 84532,
        to: OTHER_ADDRESS,
        data: '0xabcd',
        value: '0',
        nonce: 7,
        gasLimit: '100000',
        maxFeePerGasWei: '2000000000',
        maxPriorityFeePerGasWei: '1000000000',
      },
    });
  });

  test('rejects a signed transaction whose contents do not match the request', async () => {
    // The service returns a validly signed transaction, but one that pays a
    // different recipient than we asked it to sign.
    const tamperedSignedTransaction = await new ethers.Wallet(SIGNER_PRIVATE_KEY).signTransaction({
      chainId: 84532,
      to: SIGNER_ADDRESS,
      value: 0n,
      nonce: 7,
      gasLimit: 21000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockResolvedValueOnce(
        jsonResponse({
          signerAddress: SIGNER_ADDRESS,
          signedTransaction: tamperedSignedTransaction,
        }),
      );
    const signer = new ManagedSigner(
      { url: 'https://signer.internal', custodyMode: 'kms' },
      provider,
    );

    await expect(
      signer.signTransaction({
        chainId: 84532,
        to: OTHER_ADDRESS,
        value: 0n,
        nonce: 7,
        gasLimit: 21000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    ).rejects.toThrow(
      'Managed signer returned a transaction that does not match the signing request',
    );
  });

  test('rejects a signed transaction from an unexpected signer address', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockResolvedValueOnce(
        jsonResponse({ signerAddress: OTHER_ADDRESS, signedTransaction: '0xdeadbeef' }),
      );
    const signer = new ManagedSigner(
      { url: 'https://signer.internal', custodyMode: 'kms' },
      provider,
    );

    await expect(
      signer.signTransaction({ chainId: 84532, to: OTHER_ADDRESS, nonce: 1, gasLimit: 21000n }),
    ).rejects.toThrow('Managed signer returned an unexpected signer address');
  });

  test('rejects a non-hex signed transaction', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockResolvedValueOnce(jsonResponse({ signedTransaction: 'not-hex' }));
    const signer = new ManagedSigner(
      { url: 'https://signer.internal', custodyMode: 'kms' },
      provider,
    );

    await expect(
      signer.signTransaction({ chainId: 84532, to: OTHER_ADDRESS, nonce: 1, gasLimit: 21000n }),
    ).rejects.toThrow('Managed signer returned an invalid signed transaction');
  });

  test('surfaces a signing endpoint failure', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockResolvedValueOnce(jsonResponse({}, false, 503));
    const signer = new ManagedSigner(
      { url: 'https://signer.internal', custodyMode: 'kms' },
      provider,
    );

    await expect(
      signer.signTransaction({ chainId: 84532, to: OTHER_ADDRESS, nonce: 1, gasLimit: 21000n }),
    ).rejects.toThrow('Managed signer rejected transaction signing request (status 503)');
  });
});
