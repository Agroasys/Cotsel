'use strict';

function normalizeOrigin(value) {
  const parsed = new URL(value);

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`CORS origin "${value}" must not include a path, query string, or fragment`);
  }

  return `${parsed.protocol}//${parsed.host}`;
}

function parseAllowedOrigins(raw) {
  if (!raw || !raw.trim()) {
    return [];
  }

  const unique = new Set();
  for (const candidate of raw.split(',')) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }

    unique.add(normalizeOrigin(trimmed));
  }

  return [...unique];
}

function createCorsOptions(options) {
  const allowedOrigins = new Set(options.allowedOrigins || []);
  const allowNoOrigin = options.allowNoOrigin !== false;
  const credentials = options.credentials === true;

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, allowNoOrigin);
        return;
      }

      try {
        callback(null, allowedOrigins.has(normalizeOrigin(origin)));
      } catch {
        callback(null, false);
      }
    },
    credentials,
    optionsSuccessStatus: 204,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Correlation-Id',
      'X-Api-Key',
      'X-Timestamp',
      'X-Signature',
      'X-Nonce',
      'x-agroasys-timestamp',
      'x-agroasys-signature',
      'x-agroasys-nonce',
    ],
  };
}

module.exports = {
  createCorsOptions,
  parseAllowedOrigins,
};
