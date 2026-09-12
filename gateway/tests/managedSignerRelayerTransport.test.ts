import { createHttpManagedSignerTransport } from '../src/core/managedSignerTransport';
import type { ManagedSignerGaslessConfig } from '../src/core/managedSignerTransport';

const config: ManagedSignerGaslessConfig = {
  rpcUrl: 'https://rpc.example.test',
  rpcFallbackUrls: [],
  chainId: 84532,
  escrowAddress: '0x1000000000000000000000000000000000000001',
  usdcAddress: '0x2000000000000000000000000000000000000002',
  gaslessSignerCustodyMode: 'kms',
  gaslessKmsExpectedAddress: '0x3000000000000000000000000000000000000003',
  gaslessManagedSignerUrl: 'http://relayer.cotsel-staging.internal:3300',
  gaslessManagedSignerApiKey: 'gateway',
  gaslessManagedSignerApiSecret: 'test-secret',
  gaslessManagedSignerRequestTimeoutMs: 5000,
};

afterEach(() => jest.restoreAllMocks());

test('gateway authenticates relayer address lookup with HMAC and no bearer credential', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ signerAddress: config.gaslessKmsExpectedAddress }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(createHttpManagedSignerTransport(config).getSignerAddress()).resolves.toBe(
    config.gaslessKmsExpectedAddress,
  );
  const request = fetchMock.mock.calls[0][1];
  const headers = new Headers(request?.headers);
  expect(headers.get('x-api-key')).toBe('gateway');
  expect(headers.get('x-signature')).toMatch(/^[a-f0-9]{64}$/);
  expect(headers.get('authorization')).toBeNull();
});

test('gateway HMAC signature binds the exact signing request body', async () => {
  const response = {
    requestId: 'request-1',
    intentHash: `0x${'1'.repeat(64)}`,
    signerAddress: config.gaslessKmsExpectedAddress,
    signedTransaction: '0x01',
  };
  const fetchMock = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
  const request = {
    custodyMode: 'kms' as const,
    operation: 'finalize_after_dispute_window' as const,
    signerAddress: config.gaslessKmsExpectedAddress!,
    requestId: response.requestId,
    intentHash: response.intentHash,
    transaction: {
      chainId: 84532,
      to: config.escrowAddress,
      data: '0x12345678',
      value: '0',
      nonce: 7,
      gasLimit: '21000',
      type: 2 as const,
      maxFeePerGasWei: '100',
      maxPriorityFeePerGasWei: '10',
    },
  };
  await expect(createHttpManagedSignerTransport(config).signTransaction(request)).resolves.toEqual(
    response,
  );
  const options = fetchMock.mock.calls[0][1];
  expect(options?.body).toBe(JSON.stringify(request));
  const headers = new Headers(options?.headers);
  expect(headers.get('x-api-key')).toBe('gateway');
  expect(headers.get('x-signature')).toMatch(/^[a-f0-9]{64}$/);
});
