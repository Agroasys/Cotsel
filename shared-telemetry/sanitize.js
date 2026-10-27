'use strict';

const net = require('node:net');

const { FIELD_CLASS, classifyTelemetryField } = require('./fieldPolicy');

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 4096;
const MAX_DROPPED_FIELDS = 32;
const DROPPED_FIELDS_KEY = 'telemetryDroppedFields';
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`]+/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const IBAN_CANDIDATE_PATTERN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;

/** ISO 13616 mod-97 check, so trade IDs and codes are not mistaken for IBANs. */
function isIban(candidate) {
  const compact = candidate.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** Keeps scheme and host so an operator can still tell which endpoint failed. */
function endpointOrigin(value) {
  try {
    const parsed = new URL(value);
    const hasDetail =
      parsed.username !== '' ||
      parsed.password !== '' ||
      (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.search !== '' ||
      parsed.hash !== '';
    return `${parsed.protocol}//${parsed.host}${hasDetail ? '/[redacted]' : ''}`;
  } catch {
    return '[redacted-url]';
  }
}

function scrubString(value) {
  let scrubbed = value
    .replace(PEM_PRIVATE_KEY_PATTERN, '[REDACTED:private-key]')
    .replace(JWT_PATTERN, '[REDACTED:jwt]')
    .replace(AUTH_SCHEME_PATTERN, (_match, scheme) => `${scheme} [REDACTED]`)
    .replace(URL_PATTERN, (url) => endpointOrigin(url))
    .replace(EMAIL_PATTERN, '[REDACTED:email]')
    .replace(IBAN_CANDIDATE_PATTERN, (candidate) =>
      isIban(candidate) ? '[REDACTED:iban]' : candidate,
    );

  if (scrubbed.length > MAX_STRING_LENGTH) {
    scrubbed = `${scrubbed.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }
  return scrubbed;
}

/** IPv4 keeps the /24 and IPv6 the /48: enough to spot a network, not a person. */
function maskNetworkAddress(value) {
  if (typeof value !== 'string') return REDACTED;
  const address = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (net.isIPv4(address)) {
    return `${address.split('.').slice(0, 3).join('.')}.0/24`;
  }
  if (net.isIPv6(address)) {
    const [head] = address.split('::');
    const groups = head.split(':').filter((group) => group !== '');
    while (groups.length < 3) groups.push('0');
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return REDACTED;
}

function describeError(error) {
  const text = error.stack || `${error.name}: ${error.message}`;
  return scrubString(text);
}

function isBinary(value) {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function sanitizeValue(value, context, path, depth) {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return scrubString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  if (value instanceof Error) return describeError(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (isBinary(value)) return '[binary]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (context.seen.has(value)) return '[circular]';
  context.seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, context, path, depth + 1))
        .filter((item) => item !== undefined);
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[${value.length - MAX_ARRAY_ITEMS} more]`);
      }
      return items;
    }

    if (value instanceof Map) {
      return sanitizeObject(Object.fromEntries(value), context, path, depth + 1);
    }
    if (value instanceof Set) {
      return sanitizeValue([...value], context, path, depth);
    }

    return sanitizeObject(value, context, path, depth + 1);
  } finally {
    context.seen.delete(value);
  }
}

function recordDropped(context, path, key) {
  const name = FIELD_NAME_PATTERN.test(key) ? key : '<non-identifier>';
  context.dropped.add(path ? `${path}.${name}` : name);
}

function sanitizeField(key, value, context, path, depth) {
  const fieldClass = classifyTelemetryField(key);
  const fieldPath = path ? `${path}.${key}` : key;

  switch (fieldClass) {
    case 'prohibited':
      return value === undefined ? undefined : REDACTED;
    case 'unclassified':
      recordDropped(context, path, key);
      return undefined;
    case FIELD_CLASS.ENDPOINT:
      if (Array.isArray(value)) {
        return value.map((item) => (typeof item === 'string' ? endpointOrigin(item) : REDACTED));
      }
      return typeof value === 'string'
        ? endpointOrigin(value)
        : sanitizeValue(value, context, fieldPath, depth);
    case FIELD_CLASS.NETWORK_ADDRESS:
      return value === null || value === undefined ? value : maskNetworkAddress(value);
    default:
      return sanitizeValue(value, context, fieldPath, depth);
  }
}

function sanitizeObject(source, context, path, depth) {
  const sanitized = {};
  for (const [key, value] of Object.entries(source)) {
    const result = sanitizeField(key, value, context, path, depth);
    if (result !== undefined) {
      sanitized[key] = result;
    }
  }
  return sanitized;
}

/**
 * Apply the default-deny schema to one log, metric, or alert record.
 *
 * Unclassified fields are removed and listed by name under
 * `telemetryDroppedFields`; prohibited fields become `[REDACTED]`; every string
 * is scrubbed for credentials, URLs with paths, email addresses, and IBANs.
 */
function sanitizeTelemetryRecord(record) {
  const context = { seen: new WeakSet(), dropped: new Set() };
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { message: sanitizeValue(record, context, '', 0) };
  }

  const sanitized = sanitizeObject(record, context, '', 0);
  if (context.dropped.size > 0) {
    const dropped = [...context.dropped].sort();
    sanitized[DROPPED_FIELDS_KEY] =
      dropped.length > MAX_DROPPED_FIELDS
        ? [...dropped.slice(0, MAX_DROPPED_FIELDS), `[${dropped.length - MAX_DROPPED_FIELDS} more]`]
        : dropped;
  }
  return sanitized;
}

/** Sanitize and serialize: the only form in which a record should leave a service. */
function serializeTelemetryRecord(record) {
  return JSON.stringify(sanitizeTelemetryRecord(record));
}

module.exports = {
  REDACTED,
  maskNetworkAddress,
  endpointOrigin,
  scrubString,
  sanitizeTelemetryRecord,
  serializeTelemetryRecord,
};
