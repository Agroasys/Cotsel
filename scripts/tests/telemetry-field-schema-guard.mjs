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

const require = createRequire(import.meta.url);
const ts = require('typescript');
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

const LOGGER_RECEIVER = /(^|\.)(Logger|logger|log)$/u;
const LOGGER_METHODS = new Set(['debug', 'info', 'warn', 'error', 'audit']);
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

function metadataArguments(call) {
  // Logger.audit(action, tradeId, result) carries fields only in `result`.
  return call.expression.name.text === 'audit' ? call.arguments.slice(2) : call.arguments.slice(1);
}

function collectLiteralFields(objectLiteral, sourceFile, fields) {
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property) || !property.name) continue;
    if (ts.isComputedPropertyName(property.name)) continue;

    fields.push({
      name: property.name.getText(sourceFile).replace(/^['"]|['"]$/gu, ''),
      line: sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1,
    });

    if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
      collectLiteralFields(property.initializer, sourceFile, fields);
    }
  }
}

export function findLoggerFields(relativePath, source) {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  const fields = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LOGGER_METHODS.has(node.expression.name.text) &&
      LOGGER_RECEIVER.test(node.expression.expression.getText(sourceFile))
    ) {
      for (const argument of metadataArguments(node)) {
        if (ts.isObjectLiteralExpression(argument)) {
          collectLiteralFields(argument, sourceFile, fields);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

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
