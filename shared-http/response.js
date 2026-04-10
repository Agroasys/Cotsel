'use strict';

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

module.exports = {
  HttpError,
  success,
  failure,
  timestamp,
};
