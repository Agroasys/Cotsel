/** SPDX-License-Identifier: Apache-2.0 */
import backendProofFixture from './fixtures/lifecycle-retirement-proof.json';
import {
  createUserActionRetirementTransport,
  USER_ACTION_RETIREMENT_PATH,
} from '../src/core/userActionEngine/retirementTransport';
import type {
  UserActionRetirementScope,
  UserActionRetirementEvidence,
} from '../src/core/userActionEngine/retirement';
import { createServiceAuthHeaders } from '../src/core/serviceAuth';
const config = {
  url: 'https://backend.example.test' + USER_ACTION_RETIREMENT_PATH,
  owningServiceId: 'agroasys',
  apiKey: 'callback-key',
  apiSecret: 'callback-secret',
  timeoutMs: 1000,
};
const scope: UserActionRetirementScope = {
  requestId: 'request',
  ownerServiceId: 'agroasys',
  sourceOperationId: 'operation',
  packageId: 'package',
  requestFingerprint: '0x' + '1'.repeat(64),
  bindingFingerprint: '0x' + '2'.repeat(64),
  originalFundingFingerprint: '3'.repeat(64),
  chainId: 84532,
  escrowAddress: '0x' + '4'.repeat(40),
  userAddress: '0x' + '5'.repeat(40),
  nonce: '9',
  deadline: '100',
  inventoryFingerprint: '0x' + '6'.repeat(64),
  priorRetirements: [],
};
const proof = (): UserActionRetirementEvidence => ({
  scope,
  anchor: {
    chainId: 84532,
    blockNumber: '200',
    blockHash: '0x' + '7'.repeat(64),
    timestamp: '101',
  },
  authorizationNonce: '9',
  financialOutcome: {
    authority: 'settlement',
    evidenceId: 'actual-fixture-outcome',
    fingerprint: '0x' + '8'.repeat(64),
    originalFundingFingerprint: scope.originalFundingFingerprint,
    kind: 'oracle_resolved_without_user_execution',
    transactionHash: '0x' + '9'.repeat(64),
    blockNumber: '150',
    blockHash: '0x' + 'a'.repeat(64),
  },
});
describe('owning retirement HTTP evidence transport (controlled HTTP port)', () => {
  const original = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = original;
    jest.restoreAllMocks();
  });
  test('accepts the actual controlled backend PostgreSQL/Finance/global-envelope vector', async () => {
    expect(backendProofFixture.controlledLocalFixture).toBe(true);
    jest
      .mocked(fetch)
      .mockResolvedValue(new Response(JSON.stringify(backendProofFixture.response)));
    const read = createUserActionRetirementTransport({
      ...config,
      owningServiceId: backendProofFixture.scope.ownerServiceId,
    });
    expect(await read(backendProofFixture.scope)).toEqual(backendProofFixture.response.data);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('signs exact POST body/path with existing callback HMAC and scopes original owner', async () => {
    jest.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: { status: 'verified', evidence: proof() } }), {
        status: 200,
      }),
    );
    const result = await createUserActionRetirementTransport(config)(scope);
    expect(result.status).toBe('verified');
    const [url, options] = jest.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe(config.url);
    expect(options?.redirect).toBe('error');
    expect(options?.body).toBe(JSON.stringify({ scope }));
    const headers = options?.headers as Record<string, string>;
    const expected = createServiceAuthHeaders({
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      method: 'POST',
      path: USER_ACTION_RETIREMENT_PATH,
      query: '',
      body: JSON.stringify({ scope }),
      timestamp: Number(headers['X-Timestamp']),
      nonce: headers['X-Nonce'],
    });
    expect(headers['X-Signature']).toBe(expected['X-Signature']);
    expect(headers['X-Api-Key']).toBe('callback-key');
  });
  test.each(['unavailable', 'contradicted'] as const)(
    'retains only explicit safe owning %s state',
    async (status) => {
      jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { status } })));
      expect(await createUserActionRetirementTransport(config)(scope)).toEqual({ status });
    },
  );
  test.each([
    'private_json',
    'oversized',
    '404',
    '503',
    'scope_mismatch',
    'wrong_nonce',
    'wrong_chain',
    'inclusive_expiry',
    'oracle_missing_tx',
    'extra_evidence',
    'extra_status',
    'numeric_timestamp',
    'leading_zero_block',
    'oversized_block',
  ] as const)('%s cannot establish verified retirement or leak response data', async (fault) => {
    const evidence = proof();
    let body = JSON.stringify({ data: { status: 'verified', evidence } }),
      status = 200;
    if (fault === 'private_json') body = 'PRIVATE_PROVIDER_TOKEN';
    if (fault === 'oversized') body = 'x'.repeat(262145);
    if (fault === '404') status = 404;
    if (fault === '503') status = 503;
    if (fault === 'scope_mismatch') evidence.scope = { ...scope, packageId: 'foreign' };
    if (fault === 'numeric_timestamp')
      (evidence.anchor as unknown as Record<string, unknown>).timestamp = 101;
    if (fault === 'leading_zero_block') evidence.anchor.blockNumber = '0200';
    if (fault === 'oversized_block') evidence.financialOutcome.blockNumber = '1'.repeat(79);
    if (fault === 'wrong_nonce') evidence.authorizationNonce = '10';
    if (fault === 'wrong_chain') evidence.anchor.chainId = 1;
    if (fault === 'inclusive_expiry') evidence.anchor.timestamp = '100';
    if (fault === 'oracle_missing_tx') evidence.financialOutcome.transactionHash = null;
    if (fault === 'extra_evidence')
      (evidence as unknown as Record<string, unknown>).signature = 'PRIVATE_PROVIDER_TOKEN';
    if (!['private_json', 'oversized'].includes(fault))
      body = JSON.stringify({
        data:
          fault === 'extra_status'
            ? { status: 'contradicted', private: 'PRIVATE_PROVIDER_TOKEN' }
            : { status: 'verified', evidence },
      });
    jest.mocked(fetch).mockResolvedValue(new Response(body, { status }));
    expect(await createUserActionRetirementTransport(config)(scope)).toEqual({
      status: 'unavailable',
    });
  });
  test('owner mismatch denies before HTTP and unavailable read is never retried', async () => {
    const read = createUserActionRetirementTransport(config);
    expect(await read({ ...scope, ownerServiceId: 'foreign' })).toEqual({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    jest.mocked(fetch).mockRejectedValue(new Error('PRIVATE_AUTH_TOKEN'));
    expect(await read(scope)).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test.each([
    'http://backend.example.test' + USER_ACTION_RETIREMENT_PATH,
    'https://user:secret@backend.example.test' + USER_ACTION_RETIREMENT_PATH,
    'https://backend.example.test/other',
    'https://backend.example.test' + USER_ACTION_RETIREMENT_PATH + '?owner=other',
  ])('rejects unsafe or inferred endpoint %s', (url) => {
    expect(() => createUserActionRetirementTransport({ ...config, url })).toThrow('Invalid');
  });
  test('cancels oversized streaming evidence without retaining additional chunks', async () => {
    let cancel = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(262145));
      },
      cancel() {
        cancel = true;
      },
    });
    jest.mocked(fetch).mockResolvedValue(new Response(stream));
    expect(await createUserActionRetirementTransport(config)(scope)).toEqual({
      status: 'unavailable',
    });
    expect(cancel).toBe(true);
  });
});
