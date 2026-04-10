'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HttpError,
  optionalEnum,
  optionalInteger,
  requireIsoTimestamp,
  requireObject,
  requireString,
} = require('./index');

test('requireString treats missing values as required', () => {
  assert.throws(
    () => requireString(undefined, 'walletAddress'),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'ValidationError');
      assert.equal(error.message, 'walletAddress is required');
      return true;
    },
  );
});

test('requireObject rejects arrays and null', () => {
  assert.throws(() => requireObject([], 'body'), /body must be an object/);
  assert.throws(() => requireObject(null, 'body'), /body must be an object/);
});

test('optionalInteger enforces configured bounds', () => {
  assert.equal(optionalInteger('12', 'limit', { min: 1, max: 50 }), 12);
  assert.equal(optionalInteger(undefined, 'limit', { min: 1, max: 50 }), undefined);
  assert.throws(() => optionalInteger('0', 'limit', { min: 1 }), /limit must be >= 1/);
  assert.throws(() => optionalInteger('100', 'limit', { max: 50 }), /limit must be <= 50/);
});

test('optionalEnum only accepts declared values', () => {
  assert.equal(optionalEnum('csv', ['json', 'csv'], 'format'), 'csv');
  assert.equal(optionalEnum(undefined, ['json', 'csv'], 'format'), undefined);
  assert.throws(() => optionalEnum('xml', ['json', 'csv'], 'format'), /format must be one of: json, csv/);
});

test('requireIsoTimestamp parses valid timestamps', () => {
  const parsed = requireIsoTimestamp('2026-04-09T10:00:00.000Z', 'observedAt');
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.toISOString(), '2026-04-09T10:00:00.000Z');
  assert.throws(() => requireIsoTimestamp('not-a-date', 'observedAt'), /observedAt must be a valid ISO timestamp/);
});
