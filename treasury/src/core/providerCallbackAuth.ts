/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'node:crypto';

/**
 * Provider callbacks carry external completion evidence, so Cotsel's own
 * service-to-service key is not enough: it only proves that an internal caller
 * relayed the payload, not that the provider produced it. Each callback is
 * verified against the provider's own webhook secret over the exact bytes it
 * signed, inside a bounded timestamp window, and bound to a single event id.
 *
 * The header follows the `t=<unix-seconds>,v1=<hex>` convention used by the
 * treasury partners, where `v1` is HMAC-SHA256 of `<t>.<raw body>`.
 */

const SIGNATURE_HEX_REGEX = /^[a-f0-9]{64}$/i;

export type ProviderCallbackRejection =
  | 'PROVIDER_SIGNATURE_MISSING'
  | 'PROVIDER_SIGNATURE_MALFORMED'
  | 'PROVIDER_SIGNATURE_INVALID'
  | 'PROVIDER_TIMESTAMP_SKEW'
  | 'PROVIDER_UNKNOWN_PARTNER'
  | 'PROVIDER_EVENT_ID_MISSING'
  | 'PROVIDER_EVENT_ID_MISMATCH';

export class ProviderCallbackAuthError extends Error {
  readonly code: ProviderCallbackRejection;

  constructor(code: ProviderCallbackRejection, message: string) {
    super(message);
    this.name = 'ProviderCallbackAuthError';
    this.code = code;
  }
}

export interface ProviderWebhookSecret {
  partnerCode: string;
  keyId: string;
  secret: string;
}

export interface ParsedProviderSignature {
  timestampSeconds: number;
  signature: string;
}

export function parseProviderSignatureHeader(
  rawHeader: string | undefined,
): ParsedProviderSignature {
  const header = rawHeader?.trim();
  if (!header) {
    throw new ProviderCallbackAuthError(
      'PROVIDER_SIGNATURE_MISSING',
      'Provider callback is missing its signature header',
    );
  }

  let timestamp: string | undefined;
  let signature: string | undefined;

  for (const part of header.split(',')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();

    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      signature = value;
    }
  }

  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) {
    throw new ProviderCallbackAuthError(
      'PROVIDER_SIGNATURE_MALFORMED',
      'Provider callback signature header must supply t and v1 values',
    );
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new ProviderCallbackAuthError(
      'PROVIDER_SIGNATURE_MALFORMED',
      'Provider callback signature header must supply t and v1 values',
    );
  }

  return { timestampSeconds, signature };
}

export function signProviderCallback(
  secret: string,
  timestampSeconds: number,
  rawBody: Buffer,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestampSeconds}.`)
    .update(rawBody)
    .digest('hex');
}

function signatureMatches(expected: string, provided: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  const normalizedProvided = provided.trim().toLowerCase();

  if (
    !SIGNATURE_HEX_REGEX.test(normalizedExpected) ||
    !SIGNATURE_HEX_REGEX.test(normalizedProvided)
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(normalizedExpected, 'hex'),
    Buffer.from(normalizedProvided, 'hex'),
  );
}

export interface ProviderCallbackVerification {
  partnerCode: string;
  keyId: string;
  eventId: string;
  timestampSeconds: number;
}

export function verifyProviderCallback(params: {
  partnerCode: string;
  signatureHeader: string | undefined;
  headerEventId: string | undefined;
  bodyEventId: string | undefined;
  rawBody: Buffer;
  secrets: ProviderWebhookSecret[];
  nowSeconds: number;
  maxSkewSeconds: number;
}): ProviderCallbackVerification {
  const normalizedPartner = params.partnerCode.trim().toLowerCase();
  const candidates = params.secrets.filter(
    (entry) => entry.partnerCode.trim().toLowerCase() === normalizedPartner,
  );

  if (candidates.length === 0) {
    throw new ProviderCallbackAuthError(
      'PROVIDER_UNKNOWN_PARTNER',
      'No webhook secret is configured for the callback partner',
    );
  }

  const { timestampSeconds, signature } = parseProviderSignatureHeader(params.signatureHeader);

  if (Math.abs(params.nowSeconds - timestampSeconds) > params.maxSkewSeconds) {
    throw new ProviderCallbackAuthError(
      'PROVIDER_TIMESTAMP_SKEW',
      'Provider callback timestamp is outside the allowed window',
    );
  }

  const bodyEventId = params.bodyEventId?.trim();
  if (!bodyEventId) {
    throw new ProviderCallbackAuthError(
      'PROVIDER_EVENT_ID_MISSING',
      'Provider callback must carry a provider event id',
    );
  }

  const headerEventId = params.headerEventId?.trim();
  if (headerEventId && headerEventId !== bodyEventId) {
    throw new ProviderCallbackAuthError(
      'PROVIDER_EVENT_ID_MISMATCH',
      'Provider callback event id header does not match the signed payload',
    );
  }

  // The signature covers the raw bytes, so an accepted payload is the one the
  // provider signed - not a re-serialized copy of it.
  const matched = candidates.find((entry) =>
    signatureMatches(
      signProviderCallback(entry.secret, timestampSeconds, params.rawBody),
      signature,
    ),
  );

  if (!matched) {
    throw new ProviderCallbackAuthError(
      'PROVIDER_SIGNATURE_INVALID',
      'Provider callback signature does not match the signed payload',
    );
  }

  return {
    partnerCode: normalizedPartner,
    keyId: matched.keyId,
    eventId: bodyEventId,
    timestampSeconds,
  };
}

const PARTNER_CODE_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function parseProviderWebhookSecrets(raw: string | undefined): ProviderWebhookSecret[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TREASURY_PROVIDER_WEBHOOK_SECRETS_JSON must be valid JSON');
  }

  const records = Array.isArray(parsed) ? parsed : [parsed];

  return records.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`TREASURY_PROVIDER_WEBHOOK_SECRETS_JSON[${index}] must be an object`);
    }

    const candidate = entry as Record<string, unknown>;
    const partnerCode =
      typeof candidate.partnerCode === 'string' ? candidate.partnerCode.trim().toLowerCase() : '';
    const keyId = typeof candidate.keyId === 'string' ? candidate.keyId.trim() : '';
    const secret = typeof candidate.secret === 'string' ? candidate.secret.trim() : '';

    if (!PARTNER_CODE_REGEX.test(partnerCode)) {
      throw new Error(
        `TREASURY_PROVIDER_WEBHOOK_SECRETS_JSON[${index}].partnerCode must be a canonical partner code`,
      );
    }

    if (!keyId) {
      throw new Error(`TREASURY_PROVIDER_WEBHOOK_SECRETS_JSON[${index}].keyId is required`);
    }

    if (secret.length < 32) {
      throw new Error(
        `TREASURY_PROVIDER_WEBHOOK_SECRETS_JSON[${index}].secret must be at least 32 characters`,
      );
    }

    return { partnerCode, keyId, secret };
  });
}
