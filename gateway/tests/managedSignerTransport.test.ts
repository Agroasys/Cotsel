/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'node:crypto';
import {
  buildServiceAuthCanonicalString,
  signServiceAuthCanonicalString,
} from '@agroasys/shared-auth/serviceAuth';
import {
  createHttpManagedSignerTransport,
  type ManagedSignerGaslessConfig,
  type ManagedSignerRequest,
} from '../src/core/managedSignerTransport';

const originalFetch = global.fetch;
const apiSecret = 'managed-signer-test-secret-at-least-thirty-two-bytes';

const config = {
  gaslessManagedSignerUrl: 'http://relayer.cotsel-staging.internal:3300',
  gaslessManagedSignerApiKey: 'gateway',
  gaslessManagedSignerApiSecret: apiSecret,
  gaslessManagedSignerRequestTimeoutMs: 5000,
} as ManagedSignerGaslessConfig;

const request: ManagedSignerRequest = {
  custodyMode: 'kms',
  operation: 'finalize_after_dispute_window',
  signerAddress: '0x1111111111111111111111111111111111111111',
  requestId: 'request-1',
  intentHash: `0x${'1'.repeat(64)}`,
  transaction: {
    chainId: 84532,
    to: '0x2222222222222222222222222222222222222222',
    data: '0x1234',
    value: '0',
    nonce: 7,
    gasLimit: '210000',
    type: 2,
    maxFeePerGasWei: '1000000000',
    maxPriorityFeePerGasWei: '100000000',
  },
  policyContext: {
    kind: 'user_action',
    resourceId: 'handoff-1',
    actorAddress: '0x3333333333333333333333333333333333333333',
    tradeId: '9',
    authorizationNonce: '2',
    authorizationDeadline: '4102444800',
  },
};

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function expectValidServiceAuth(headers: Record<string, string>, path: string, body: string): void {
  expect(headers['X-Api-Key']).toBe('gateway');
  const canonical = buildServiceAuthCanonicalString({
    method: 'POST',
    path,
    query: '',
    bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
    timestamp: headers['X-Timestamp'],
    nonce: headers['X-Nonce'],
  });
  expect(headers['X-Signature']).toBe(signServiceAuthCanonicalString(apiSecret, canonical));
}

test('signing requests use body-bound service authentication', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      requestId: request.requestId,
      intentHash: request.intentHash,
      signerAddress: request.signerAddress,
      signedTransaction: '0x1234',
    }),
  } as Response);

  await createHttpManagedSignerTransport(config).signTransaction(request);

  const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
  const body = String(init.body);
  expect(url).toBe(
    'http://relayer.cotsel-staging.internal:3300/api/signers/gasless-relayer/sign-transaction',
  );
  expect(body).toBe(JSON.stringify(request));
  expectValidServiceAuth(
    init.headers as Record<string, string>,
    '/api/signers/gasless-relayer/sign-transaction',
    body,
  );
});

test('uses a 30 second default timeout for the complete KMS signing round trip', async () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout');
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      requestId: request.requestId,
      intentHash: request.intentHash,
      signerAddress: request.signerAddress,
      signedTransaction: '0x1234',
    }),
  } as Response);

  await createHttpManagedSignerTransport({
    ...config,
    gaslessManagedSignerRequestTimeoutMs: undefined,
  }).signTransaction(request);

  expect(timeout).toHaveBeenCalledWith(30_000);
});
