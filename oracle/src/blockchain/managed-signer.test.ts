import { ethers } from 'ethers';
import { ManagedSigner } from './managed-signer';

const testSigner = ethers.Wallet.createRandom();
const SIGNER_ADDRESS = testSigner.address;
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

function echoSigningRequest(init: RequestInit, body: Record<string, unknown>): Response {
  const request = JSON.parse(String(init.body)) as { requestId: string; intentHash: string };
  return jsonResponse({
    ...body,
    requestId: request.requestId,
    intentHash: request.intentHash,
  });
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
    const recordValidationEvidence = jest.fn();
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
    const signedTransaction = await testSigner.signTransaction(request);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockImplementationOnce((_url, init: RequestInit) =>
        echoSigningRequest(init, { signerAddress: SIGNER_ADDRESS, signedTransaction }),
      );
    const signer = new ManagedSigner(
      { url: 'https://signer.internal', custodyMode: 'kms', recordValidationEvidence },
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
      requestId: expect.any(String),
      intentHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
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
        type: 2,
      },
    });
    expect(recordValidationEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: body.requestId,
        intentHash: body.intentHash,
        signedTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        signerAddress: SIGNER_ADDRESS,
        nonce: 7,
        transactionType: 2,
        outcome: 'accepted',
      }),
    );
  });

  test('rejects a signed transaction whose contents do not match the request', async () => {
    const recordValidationEvidence = jest.fn();
    // The service returns a validly signed transaction, but one that pays a
    // different recipient than we asked it to sign.
    const tamperedSignedTransaction = await testSigner.signTransaction({
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
      .mockImplementationOnce((_url, init: RequestInit) =>
        echoSigningRequest(init, {
          signerAddress: SIGNER_ADDRESS,
          signedTransaction: tamperedSignedTransaction,
        }),
      );
    const signer = new ManagedSigner(
      { url: 'https://signer.internal', custodyMode: 'kms', recordValidationEvidence },
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
    ).rejects.toThrow('Managed signer changed the approved transaction recipient');
    expect(recordValidationEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'rejected',
        failureReason: 'recipient',
        signedTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      }),
    );
  });

  test('rejects a signed transaction from an unexpected signer address', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockImplementationOnce((_url, init: RequestInit) =>
        echoSigningRequest(init, {
          signerAddress: OTHER_ADDRESS,
          signedTransaction: '0xdeadbeef',
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
        nonce: 1,
        gasLimit: 21000n,
        gasPrice: 1n,
      }),
    ).rejects.toMatchObject({ reason: 'response_signer' });
  });

  test('rejects a non-hex signed transaction', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockImplementationOnce((_url, init: RequestInit) =>
        echoSigningRequest(init, {
          signerAddress: SIGNER_ADDRESS,
          signedTransaction: 'not-hex',
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
        nonce: 1,
        gasLimit: 21000n,
        gasPrice: 1n,
      }),
    ).rejects.toMatchObject({ reason: 'response_format' });
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
      signer.signTransaction({
        chainId: 84532,
        to: OTHER_ADDRESS,
        nonce: 1,
        gasLimit: 21000n,
        gasPrice: 1n,
      }),
    ).rejects.toThrow('Managed signer rejected transaction signing request (status 503)');
  });

  test('rejects a response that is not bound to the one-time request and intent', async () => {
    const recordValidationEvidence = jest.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ signerAddress: SIGNER_ADDRESS }))
      .mockResolvedValueOnce(
        jsonResponse({
          signerAddress: SIGNER_ADDRESS,
          requestId: 'different-request',
          intentHash: `0x${'0'.repeat(64)}`,
          signedTransaction: '0xdeadbeef',
        }),
      );
    const signer = new ManagedSigner(
      { url: 'https://signer.internal', custodyMode: 'kms', recordValidationEvidence },
      provider,
    );

    await expect(
      signer.signTransaction({
        chainId: 84532,
        to: OTHER_ADDRESS,
        nonce: 1,
        gasLimit: 21000n,
        gasPrice: 1n,
      }),
    ).rejects.toMatchObject({ reason: 'response_request_id' });
    expect(recordValidationEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'rejected',
        failureReason: 'response_request_id',
        signedTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      }),
    );
  });
});
