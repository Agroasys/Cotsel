/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  buildServiceAuthCanonicalString,
  createServiceAuthHeaders,
  signServiceAuthCanonicalString,
} from '../src/modules/serviceAuth';

describe('service auth client helper', () => {
  test('builds deterministic headers for fixed input', () => {
    const headers = createServiceAuthHeaders({
      apiKey: 'svc-a',
      apiSecret: 'secret-a',
      method: 'POST',
      path: '/api/ricardian/v1/hash',
      query: 'foo=bar',
      body: '{"x":1}',
      timestamp: 1700000000,
      nonce: 'nonce-1',
    });

    expect(headers['X-Api-Key']).toBe('svc-a');
    expect(headers['X-Timestamp']).toBe('1700000000');
    expect(headers['X-Nonce']).toBe('nonce-1');
    expect(headers['X-Signature']).toBe(
      'a8db0468fa0ffe8da6d75da757be1b6feda3530092339f903c9745ccfd519e63',
    );
  });

  test('canonical string builder and signer match helper output', () => {
    const canonical = buildServiceAuthCanonicalString({
      method: 'GET',
      path: '/api/treasury/v1/entries',
      query: 'tradeId=t-1',
      bodySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      timestamp: '1700000000',
      nonce: 'nonce-2',
    });

    const signature = signServiceAuthCanonicalString('secret-a', canonical);

    expect(signature).toBe('e9090f921db384d7ade635bae32b73238b97583a999c81612f723aa8d78e29da');
  });

  test('query normalization strips leading question mark', () => {
    const withPrefix = createServiceAuthHeaders({
      apiKey: 'svc-a',
      apiSecret: 'secret-a',
      method: 'GET',
      path: '/api/ricardian/v1/hash/abc',
      query: '?a=1',
      timestamp: 1700000000,
      nonce: 'nonce-3',
    });

    const withoutPrefix = createServiceAuthHeaders({
      apiKey: 'svc-a',
      apiSecret: 'secret-a',
      method: 'GET',
      path: '/api/ricardian/v1/hash/abc',
      query: 'a=1',
      timestamp: 1700000000,
      nonce: 'nonce-3',
    });

    expect(withPrefix['X-Signature']).toBe(withoutPrefix['X-Signature']);
  });
});
