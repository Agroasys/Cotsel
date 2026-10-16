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

const CALLER_SAFE = Symbol.for('agroasys.shared-http.callerSafeError');

/**
 * A refusal whose message was written for the caller. Throwing it is the only
 * way a non-HTTP error keeps its text in a response: every other error, however
 * plain it looks, may carry driver, network, RPC or provider output.
 */
class CallerSafeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CallerSafeError';
    Object.defineProperty(this, CALLER_SAFE, { value: true });
  }
}

function isCallerSafeError(error) {
  return error instanceof HttpError || (error instanceof Error && error[CALLER_SAFE] === true);
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
  CallerSafeError,
  isCallerSafeError,
  sendInternalFailure,
  success,
  failure,
  timestamp,
};
