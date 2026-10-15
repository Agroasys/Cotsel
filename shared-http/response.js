'use strict';

const { randomUUID } = require('node:crypto');

const CORRELATION_ID_HEADERS = ['x-correlation-id', 'x-request-id'];
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const INTERNAL_ERROR_MESSAGE = 'An unexpected error occurred';

function timestamp() {
  return new Date().toISOString();
}

function success(data) {
  return {
    success: true,
    data,
    timestamp: timestamp(),
  };
}

function failure(code, message, details) {
  return {
    success: false,
    error: code,
    message,
    ...(details ? { details } : {}),
    timestamp: timestamp(),
  };
}

class HttpError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Reuses a well-formed inbound correlation header so one ID spans services;
 * anything else gets a fresh ID rather than echoing caller-controlled text.
 */
function correlationIdFor(req) {
  for (const header of CORRELATION_ID_HEADERS) {
    const value = req && req.headers ? req.headers[header] : undefined;
    if (typeof value === 'string' && CORRELATION_ID_PATTERN.test(value)) {
      return value;
    }
  }
  return randomUUID();
}

/**
 * Domain checks throw a bare `Error` whose message is written for the caller.
 * Driver, network, RPC, signer and timeout failures are subclasses or carry a
 * `code` (SQLSTATE, errno, ethers), and their text can hold queries, hosts or URLs.
 */
function isCallerFacingError(error) {
  return (
    error instanceof Error && Object.getPrototypeOf(error) === Error.prototype && !('code' in error)
  );
}

/**
 * Answers an unexpected failure with a stable code and a correlation ID only.
 * The raw error goes to `log`, never to the caller: it can carry SQL, RPC or
 * provider URLs, signer output, or stack traces.
 */
function sendInternalFailure(req, res, error, options) {
  const correlationId = correlationIdFor(req);
  options.log(correlationId, error);
  if (typeof res.setHeader === 'function') {
    res.setHeader('x-correlation-id', correlationId);
  }
  res.status(options.statusCode || 500).json({
    ...failure(options.code || 'InternalError', options.message || INTERNAL_ERROR_MESSAGE),
    ...(options.fields || {}),
    correlationId,
  });
  return correlationId;
}

module.exports = {
  HttpError,
  INTERNAL_ERROR_MESSAGE,
  correlationIdFor,
  isCallerFacingError,
  sendInternalFailure,
  success,
  failure,
  timestamp,
};
