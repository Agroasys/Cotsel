'use strict';

const { HttpError } = require('./response');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, field) {
  if (!isPlainObject(value)) {
    throw new HttpError(400, 'ValidationError', `${field} must be an object`);
  }

  return value;
}

function requireString(value, field) {
  if (value === undefined || value === null) {
    throw new HttpError(400, 'ValidationError', `${field} is required`);
  }

  if (typeof value !== 'string') {
    throw new HttpError(400, 'ValidationError', `${field} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new HttpError(400, 'ValidationError', `${field} is required`);
  }

  return normalized;
}

function optionalString(value, field) {
  if (value === undefined) {
    return undefined;
  }

  return requireString(value, field);
}

function optionalNullableString(value, field) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return requireString(value, field);
}

function requireEnum(value, allowedValues, field) {
  const normalized = requireString(value, field);
  if (!allowedValues.includes(normalized)) {
    throw new HttpError(
      400,
      'ValidationError',
      `${field} must be one of: ${allowedValues.join(', ')}`,
    );
  }

  return normalized;
}

function optionalEnum(value, allowedValues, field) {
  if (value === undefined) {
    return undefined;
  }

  return requireEnum(value, allowedValues, field);
}

function optionalInteger(value, field, { min, max } = {}) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new HttpError(400, 'ValidationError', `${field} must be an integer`);
    }
    return assertIntegerBounds(value, field, { min, max });
  }

  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    throw new HttpError(400, 'ValidationError', `${field} must be an integer`);
  }

  return assertIntegerBounds(Number.parseInt(value.trim(), 10), field, { min, max });
}

function requireInteger(value, field, options) {
  const parsed = optionalInteger(value, field, options);
  if (parsed === undefined) {
    throw new HttpError(400, 'ValidationError', `${field} is required`);
  }

  return parsed;
}

function assertIntegerBounds(value, field, { min, max } = {}) {
  if (min !== undefined && value < min) {
    throw new HttpError(400, 'ValidationError', `${field} must be >= ${min}`);
  }

  if (max !== undefined && value > max) {
    throw new HttpError(400, 'ValidationError', `${field} must be <= ${max}`);
  }

  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  throw new HttpError(400, 'ValidationError', `${field} must be a boolean`);
}

function requireIsoTimestamp(value, field) {
  const normalized = requireString(value, field);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, 'ValidationError', `${field} must be a valid ISO timestamp`);
  }

  return parsed;
}

function optionalRecord(value, field) {
  if (value === undefined) {
    return undefined;
  }

  return requireObject(value, field);
}

module.exports = {
  isPlainObject,
  requireObject,
  requireString,
  optionalString,
  optionalNullableString,
  requireEnum,
  optionalEnum,
  requireInteger,
  optionalInteger,
  optionalBoolean,
  requireIsoTimestamp,
  optionalRecord,
};
