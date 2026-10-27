#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-8 COMP-04: every field a service names in a logger call must be classified
 * in the shared telemetry schema. The runtime sanitizer drops unclassified
 * fields; this guard makes the omission a review-time failure instead of a
 * silent production gap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Dependency-free on purpose: ci/docs-profile-guard runs without node_modules.
const require = createRequire(import.meta.url);
const { classifyTelemetryField } = require('../../shared-telemetry');

export const SERVICE_SOURCE_ROOTS = [
  'auth/src',
  'gateway/src',
  'indexer/src',
  'notifications/src',
  'oracle/src',
  'reconciliation/src',
  'relayer/src',
  'ricardian/src',
  'treasury/src',
];

const LOGGER_CALL =
  /(?<![\w$.?])((?:[\w$]+\s*\??\.\s*)*(?:Logger|logger|log))\s*\??\.\s*(debug|info|warn|error|audit)\s*\(/gu;
const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'lib', 'tests', 'test', '__tests__']);

function listSourceFiles(root, directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];

  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...listSourceFiles(root, relative));
    } else if (/\.ts$/u.test(entry.name) && !/\.(test|spec|d)\.ts$/u.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

/**
 * Blank out comments and string contents, keeping offsets and newlines, so
 * brackets and commas inside them cannot confuse the argument scanner.
 * Template literal `${...}` expressions stay visible as code.
 */
export function maskNonCode(source) {
  const out = source.split('');
  const blank = (index) => {
    if (out[index] !== '\n') out[index] = ' ';
  };
  const templateDepths = [];
  let braceDepth = 0;
  let index = 0;

  const skipTemplate = () => {
    // Positioned just after a backtick or a closing `}` of an interpolation.
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        blank(index);
        blank(index + 1);
        index += 2;
      } else if (char === '`') {
        index += 1;
        return;
      } else if (char === '$' && source[index + 1] === '{') {
        templateDepths.push(braceDepth);
        braceDepth += 1;
        index += 2;
        return;
      } else {
        blank(index);
        index += 1;
      }
    }
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') blank(index++);
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const stop = close === -1 ? source.length : close + 2;
      while (index < stop) blank(index++);
    } else if (char === "'" || char === '"') {
      index += 1;
      while (index < source.length && source[index] !== char && source[index] !== '\n') {
        if (source[index] === '\\') blank(index++);
        blank(index++);
      }
      index += 1;
    } else if (char === '`') {
      index += 1;
      skipTemplate();
    } else if (char === '{') {
      braceDepth += 1;
      index += 1;
    } else if (char === '}') {
      braceDepth -= 1;
      index += 1;
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braceDepth) {
        templateDepths.pop();
        skipTemplate();
      }
    } else {
      index += 1;
    }
  }

  return out.join('');
}

/** Split `masked[from, to)` at top-level commas into trimmed [start, end) ranges. */
function splitTopLevel(masked, from, to) {
  const ranges = [];
  const stack = [];
  let segmentStart = from;

  for (let index = from; index <= to; index += 1) {
    const char = index === to ? ',' : masked[index];
    if (OPENERS[char]) {
      stack.push(OPENERS[char]);
    } else if (CLOSERS.has(char)) {
      stack.pop();
    } else if (char === ',' && stack.length === 0) {
      let start = segmentStart;
      let end = index;
      while (start < end && /\s/u.test(masked[start])) start += 1;
      while (end > start && /\s/u.test(masked[end - 1])) end -= 1;
      if (end > start) ranges.push([start, end]);
      segmentStart = index + 1;
    }
  }
  return ranges;
}

/** Index of the bracket that closes the one at `open`, or -1. */
function matchingBracket(masked, open) {
  const stack = [];
  for (let index = open; index < masked.length; index += 1) {
    const char = masked[index];
    if (OPENERS[char]) {
      stack.push(OPENERS[char]);
    } else if (CLOSERS.has(char)) {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

/** True when the range is exactly one object literal, not `{...} as T` or `{...}.x`. */
function isObjectLiteral(masked, [start, end]) {
  return masked[start] === '{' && matchingBracket(masked, start) === end - 1;
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

const PROPERTY_KEY = /^(?:(['"])([^'"]*)\1|([A-Za-z_$][\w$]*))/u;

function collectLiteralFields(source, masked, [start, end], fields) {
  for (const [propertyStart, propertyEnd] of splitTopLevel(masked, start + 1, end - 1)) {
    const text = source.slice(propertyStart, propertyEnd);
    if (text.startsWith('...') || text.startsWith('[')) continue;

    const key = PROPERTY_KEY.exec(text);
    if (!key) continue;
    fields.push({ name: key[2] ?? key[3], line: lineAt(source, propertyStart) });

    let valueStart = propertyStart + key[0].length;
    while (valueStart < propertyEnd && /\s/u.test(masked[valueStart])) valueStart += 1;
    if (masked[valueStart] !== ':') continue;
    valueStart += 1;
    while (valueStart < propertyEnd && /\s/u.test(masked[valueStart])) valueStart += 1;

    if (isObjectLiteral(masked, [valueStart, propertyEnd])) {
      collectLiteralFields(source, masked, [valueStart, propertyEnd], fields);
    }
  }
}

export function findLoggerFields(_relativePath, source) {
  const masked = maskNonCode(source);
  const fields = [];

  for (const call of masked.matchAll(LOGGER_CALL)) {
    const open = call.index + call[0].length - 1;
    const close = matchingBracket(masked, open);
    if (close === -1) continue;

    // Logger.audit(action, tradeId, result) carries fields only in `result`.
    const skipped = call[2] === 'audit' ? 2 : 1;
    for (const range of splitTopLevel(masked, open + 1, close).slice(skipped)) {
      if (isObjectLiteral(masked, range)) {
        collectLiteralFields(source, masked, range, fields);
      }
    }
  }

  return fields;
}

export function checkTelemetryFields(root = process.cwd()) {
  const errors = [];
  let fieldCount = 0;

  for (const sourceRoot of SERVICE_SOURCE_ROOTS) {
    for (const relativePath of listSourceFiles(root, sourceRoot)) {
      const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
      for (const field of findLoggerFields(relativePath, source)) {
        fieldCount += 1;
        const fieldClass = classifyTelemetryField(field.name);
        if (fieldClass === 'prohibited') {
          errors.push(
            `${relativePath}:${field.line}: prohibited field "${field.name}" passed to a logger`,
          );
        } else if (fieldClass === 'unclassified') {
          errors.push(
            `${relativePath}:${field.line}: field "${field.name}" is not classified in shared-telemetry/fieldPolicy.js`,
          );
        }
      }
    }
  }

  return { errors, fieldCount };
}

function main() {
  const { errors, fieldCount } = checkTelemetryFields();
  if (errors.length > 0) {
    for (const error of errors) console.error(`[FAIL] ${error}`);
    process.exit(1);
  }
  console.log(`Telemetry field schema guard: pass (${fieldCount} logger fields classified)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
