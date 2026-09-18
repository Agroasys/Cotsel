/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 H-16: provider callbacks carry external completion evidence, so they are
 * verified against the provider's own webhook secret rather than accepted on
 * the strength of Cotsel's internal service key alone.
 */
import {
  parseProviderWebhookSecrets,
  ProviderCallbackAuthError,
  signProviderCallback,
  verifyProviderCallback,
  type ProviderWebhookSecret,
} from '../src/core/providerCallbackAuth';

const SECRET = 'bridge-webhook-secret-value-that-is-long-enough';
const secrets: ProviderWebhookSecret[] = [
  { partnerCode: 'bridge', keyId: 'bridge-live', secret: SECRET },
];

const NOW = 1_800_000_000;
const rawBody = Buffer.from(
  JSON.stringify({ providerEventId: 'evt-1', partnerStatus: 'COMPLETED' }),
);

function verify(overrides: Partial<Parameters<typeof verifyProviderCallback>[0]> = {}) {
  return verifyProviderCallback({
    partnerCode: 'bridge',
    signatureHeader: `t=${NOW},v1=${signProviderCallback(SECRET, NOW, rawBody)}`,
    headerEventId: 'evt-1',
    bodyEventId: 'evt-1',
    rawBody,
    secrets,
    nowSeconds: NOW,
    maxSkewSeconds: 300,
    ...overrides,
  });
}

function rejectionCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderCallbackAuthError);
    return (error as ProviderCallbackAuthError).code;
  }

  throw new Error('expected the callback to be rejected');
}

describe('treasury provider callback verification', () => {
  it('accepts a callback the provider signed', () => {
    expect(verify()).toEqual({
      partnerCode: 'bridge',
      keyId: 'bridge-live',
      eventId: 'evt-1',
      timestampSeconds: NOW,
    });
  });

  it('accepts a callback that omits the optional event-id header', () => {
    expect(verify({ headerEventId: undefined }).eventId).toBe('evt-1');
  });

  it('rejects a callback signed with the wrong secret', () => {
    const forged = signProviderCallback('another-secret-entirely-long-enough', NOW, rawBody);

    expect(rejectionCode(() => verify({ signatureHeader: `t=${NOW},v1=${forged}` }))).toBe(
      'PROVIDER_SIGNATURE_INVALID',
    );
  });

  it('rejects a payload that changed after it was signed', () => {
    const tampered = Buffer.from(
      JSON.stringify({ providerEventId: 'evt-1', partnerStatus: 'FAILED' }),
    );

    expect(rejectionCode(() => verify({ rawBody: tampered }))).toBe('PROVIDER_SIGNATURE_INVALID');
  });

  it('rejects a callback outside the signed timestamp window', () => {
    expect(rejectionCode(() => verify({ nowSeconds: NOW + 301 }))).toBe('PROVIDER_TIMESTAMP_SKEW');
    expect(rejectionCode(() => verify({ nowSeconds: NOW - 301 }))).toBe('PROVIDER_TIMESTAMP_SKEW');
    expect(verify({ nowSeconds: NOW + 299 }).eventId).toBe('evt-1');
  });

  it('rejects a captured signature replayed against a different event id', () => {
    expect(rejectionCode(() => verify({ headerEventId: 'evt-2' }))).toBe(
      'PROVIDER_EVENT_ID_MISMATCH',
    );
  });

  it('rejects a callback that carries no event id to be idempotent on', () => {
    expect(rejectionCode(() => verify({ bodyEventId: undefined }))).toBe(
      'PROVIDER_EVENT_ID_MISSING',
    );
    expect(rejectionCode(() => verify({ bodyEventId: '  ' }))).toBe('PROVIDER_EVENT_ID_MISSING');
  });

  it('rejects a partner with no configured secret instead of guessing one', () => {
    expect(rejectionCode(() => verify({ partnerCode: 'unconfigured' }))).toBe(
      'PROVIDER_UNKNOWN_PARTNER',
    );
    expect(rejectionCode(() => verify({ partnerCode: '' }))).toBe('PROVIDER_UNKNOWN_PARTNER');
  });

  it('rejects missing and malformed signature headers', () => {
    expect(rejectionCode(() => verify({ signatureHeader: undefined }))).toBe(
      'PROVIDER_SIGNATURE_MISSING',
    );
    expect(rejectionCode(() => verify({ signatureHeader: 'v1=abc' }))).toBe(
      'PROVIDER_SIGNATURE_MALFORMED',
    );
    expect(rejectionCode(() => verify({ signatureHeader: `t=not-a-number,v1=abc` }))).toBe(
      'PROVIDER_SIGNATURE_MALFORMED',
    );
    expect(rejectionCode(() => verify({ signatureHeader: `t=${NOW},v1=zz` }))).toBe(
      'PROVIDER_SIGNATURE_INVALID',
    );
  });

  it('accepts a rotated secret while the previous one is still live', () => {
    const rotating: ProviderWebhookSecret[] = [
      { partnerCode: 'bridge', keyId: 'bridge-next', secret: 'a-newly-rotated-secret-long-enough' },
      ...secrets,
    ];

    expect(verify({ secrets: rotating }).keyId).toBe('bridge-live');
  });
});

describe('treasury provider webhook secret configuration', () => {
  it('parses configured partners and normalises the partner code', () => {
    expect(
      parseProviderWebhookSecrets(
        JSON.stringify([{ partnerCode: 'Bridge', keyId: 'bridge-live', secret: SECRET }]),
      ),
    ).toEqual([{ partnerCode: 'bridge', keyId: 'bridge-live', secret: SECRET }]);
  });

  it('treats an absent configuration as no configured partners', () => {
    expect(parseProviderWebhookSecrets(undefined)).toEqual([]);
    expect(parseProviderWebhookSecrets('   ')).toEqual([]);
  });

  it('refuses configuration that cannot verify anything', () => {
    expect(() => parseProviderWebhookSecrets('not json')).toThrow('must be valid JSON');
    expect(() =>
      parseProviderWebhookSecrets(JSON.stringify([{ keyId: 'k', secret: SECRET }])),
    ).toThrow('partnerCode must be a canonical partner code');
    expect(() =>
      parseProviderWebhookSecrets(JSON.stringify([{ partnerCode: 'bridge', secret: SECRET }])),
    ).toThrow('keyId is required');
    expect(() =>
      parseProviderWebhookSecrets(
        JSON.stringify([{ partnerCode: 'bridge', keyId: 'bridge-live', secret: 'short' }]),
      ),
    ).toThrow('must be at least 32 characters');
  });
});
