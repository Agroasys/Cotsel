'use strict';

const crypto = require('crypto');

const SIGNATURE_HEX_REGEX = /^[a-f0-9]{64}$/i;
const API_KEY_MAX_LENGTH = 128;
const NONCE_MAX_LENGTH = 255;
const SHARED_HMAC_KEY_ID = '__shared_hmac__';

function bodyHash(rawBody) {
  return crypto.createHash('sha256').update(rawBody || Buffer.alloc(0)).digest('hex');
}

function timingSafeHexEquals(a, b) {
  const normalizedA = String(a || '').trim().toLowerCase();
  const normalizedB = String(b || '').trim().toLowerCase();

  if (!SIGNATURE_HEX_REGEX.test(normalizedA) || !SIGNATURE_HEX_REGEX.test(normalizedB)) {
    return false;
  }

  const aBuffer = Buffer.from(normalizedA, 'hex');
  const bBuffer = Buffer.from(normalizedB, 'hex');

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function authError(res, statusCode, code, message, onAuthFailure) {
  onAuthFailure(code);
  res.status(statusCode).json({
    success: false,
    code,
    error: message,
  });
}

function unauthorized(res, code, message, onAuthFailure) {
  authError(res, 401, code, message, onAuthFailure);
}

function forbidden(res, message, onAuthFailure) {
  authError(res, 403, 'AUTH_FORBIDDEN', message, onAuthFailure);
}

function unavailable(res, onAuthFailure) {
  authError(res, 503, 'AUTH_UNAVAILABLE', 'Authentication service unavailable', onAuthFailure);
}

function requestPathAndQuery(req) {
  const url = req.originalUrl;
  const separatorIndex = url.indexOf('?');

  if (separatorIndex === -1) {
    return { path: url, query: '' };
  }

  return {
    path: url.slice(0, separatorIndex),
    query: url.slice(separatorIndex + 1),
  };
}

function parseActiveFlag(rawActive, index) {
  if (typeof rawActive === 'boolean') {
    return rawActive;
  }

  throw new Error(`API_KEYS_JSON[${index}].active must be a boolean true or false`);
}

function firstHeader(req, headerNames) {
  for (const headerName of headerNames) {
    const value = req.header(headerName);
    if (value && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function resolvePrincipal(apiKey, options) {
  if (apiKey) {
    if (apiKey.length > API_KEY_MAX_LENGTH) {
      return null;
    }

    const apiKeyRecord = options.lookupApiKey(apiKey);
    if (!apiKeyRecord) {
      return null;
    }

    return {
      id: apiKeyRecord.id,
      secret: apiKeyRecord.secret,
      active: apiKeyRecord.active,
      scheme: 'api_key',
    };
  }

  if (options.sharedSecret && options.sharedSecret.trim()) {
    return {
      id: SHARED_HMAC_KEY_ID,
      secret: options.sharedSecret.trim(),
      active: true,
      scheme: 'shared_secret',
    };
  }

  return null;
}

function deriveNonce(parts) {
  return crypto
    .createHash('sha256')
    .update([parts.method, parts.path, parts.query, parts.bodySha256, parts.timestamp].join('\n'))
    .digest('hex')
    .slice(0, NONCE_MAX_LENGTH);
}

function buildServiceAuthCanonicalString(parts) {
  return [parts.method, parts.path, parts.query, parts.bodySha256, parts.timestamp, parts.nonce].join('\n');
}

function signServiceAuthCanonicalString(secret, canonicalString) {
  return crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
}

function parseServiceApiKeys(raw) {
  if (!raw || !raw.trim()) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('API_KEYS_JSON must be valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('API_KEYS_JSON must be an array');
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`API_KEYS_JSON[${index}] must be an object`);
    }

    const candidate = entry;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const secret = typeof candidate.secret === 'string' ? candidate.secret.trim() : '';
    const active = parseActiveFlag(candidate.active, index);

    if (!id) {
      throw new Error('API_KEYS_JSON[].id is required');
    }

    if (id.length > API_KEY_MAX_LENGTH) {
      throw new Error(`API_KEYS_JSON[${index}].id must be <= ${API_KEY_MAX_LENGTH} characters`);
    }

    if (!secret) {
      throw new Error(`API_KEYS_JSON[${index}].secret is required`);
    }

    return {
      id,
      secret,
      active,
    };
  });
}

function createServiceAuthMiddleware(options) {
  const nowSeconds = options.nowSeconds || (() => Math.floor(Date.now() / 1000));
  const onAuthFailure = typeof options.onAuthFailure === 'function' ? options.onAuthFailure : () => undefined;
  const onReplayReject = typeof options.onReplayReject === 'function' ? options.onReplayReject : () => undefined;

  return async (req, res, next) => {
    if (!options.enabled) {
      next();
      return;
    }

    const apiKey = firstHeader(req, ['X-Api-Key']);
    const timestamp = firstHeader(req, ['x-agroasys-timestamp', 'X-Timestamp']);
    const nonceHeader = firstHeader(req, ['x-agroasys-nonce', 'X-Nonce']);
    const signature = firstHeader(req, ['x-agroasys-signature', 'X-Signature']);

    if (!timestamp || !signature) {
      unauthorized(res, 'AUTH_MISSING_HEADERS', 'Missing authentication headers', onAuthFailure);
      return;
    }

    if (!/^\d+$/.test(timestamp)) {
      unauthorized(res, 'AUTH_INVALID_TIMESTAMP', 'Invalid timestamp format', onAuthFailure);
      return;
    }

    const timestampSeconds = Number.parseInt(timestamp, 10);
    if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
      unauthorized(res, 'AUTH_INVALID_TIMESTAMP', 'Invalid timestamp format', onAuthFailure);
      return;
    }

    const skew = Math.abs(nowSeconds() - timestampSeconds);
    if (skew > options.maxSkewSeconds) {
      unauthorized(res, 'AUTH_TIMESTAMP_SKEW', 'Timestamp outside allowed skew window', onAuthFailure);
      return;
    }

    const principal = resolvePrincipal(apiKey, options);
    if (!principal) {
      unauthorized(res, 'AUTH_UNKNOWN_API_KEY', 'Unknown API key', onAuthFailure);
      return;
    }

    if (!principal.active) {
      forbidden(res, 'API key is inactive', onAuthFailure);
      return;
    }

    const { path, query } = requestPathAndQuery(req);
    const bodySha256 = bodyHash(req.rawBody);
    const nonce = nonceHeader || deriveNonce({
      method: req.method.toUpperCase(),
      path,
      query,
      bodySha256,
      timestamp,
    });

    if (!nonce.trim() || nonce.length > NONCE_MAX_LENGTH) {
      unauthorized(res, 'AUTH_INVALID_NONCE', 'Invalid nonce format', onAuthFailure);
      return;
    }

    const canonicalString = buildServiceAuthCanonicalString({
      method: req.method.toUpperCase(),
      path,
      query,
      bodySha256,
      timestamp,
      nonce,
    });

    const expectedSignature = signServiceAuthCanonicalString(principal.secret, canonicalString);
    if (!timingSafeHexEquals(signature, expectedSignature)) {
      unauthorized(res, 'AUTH_INVALID_SIGNATURE', 'Invalid signature', onAuthFailure);
      return;
    }

    try {
      const accepted = await options.consumeNonce(principal.id, nonce, options.nonceTtlSeconds);
      if (!accepted) {
        onReplayReject();
        unauthorized(res, 'AUTH_NONCE_REPLAY', 'Replay detected for nonce', onAuthFailure);
        return;
      }
    } catch {
      unavailable(res, onAuthFailure);
      return;
    }

    req.serviceAuth = {
      apiKeyId: principal.id,
      scheme: principal.scheme,
    };

    next();
  };
}

module.exports = {
  buildServiceAuthCanonicalString,
  createServiceAuthMiddleware,
  parseServiceApiKeys,
  signServiceAuthCanonicalString,
};
