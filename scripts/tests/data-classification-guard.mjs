#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

const POLICY_PATH = 'docs/security/data-classification-policy.md';
const DOC_TARGET_ROOTS = [
  'docs/api',
  'docs/incidents',
  'docs/observability',
  'docs/runbooks',
];
const DOC_TARGET_EXTENSIONS = new Set(['.md', '.yml', '.yaml']);

const LOGGER_TARGETS = [
  'gateway/src/logging/logger.ts',
  'oracle/src/utils/logger.ts',
  'treasury/src/utils/logger.ts',
  'reconciliation/src/utils/logger.ts',
];

const BANNED_FIELD_NAMES = [
  'privateKey',
  'privateKeys',
  'seedPhrase',
  'mnemonic',
  'apiKey',
  'apiSecret',
  'accessToken',
  'refreshToken',
  'bearerToken',
  'sessionToken',
  'hmacSecret',
  'hmacKey',
  'signatureSecret',
  'canonicalString',
  'bankAccountNumber',
  'routingNumber',
  'iban',
  'swiftCode',
  'bic',
  'passportNumber',
  'nationalId',
  'dateOfBirth',
];

const REQUIRED_POLICY_SNIPPETS = [
  '## Classification levels',
  '## Allowed in generic logs and runbooks',
  '## Prohibited in generic logs and runbooks',
  'scripts/tests/data-classification-guard.mjs',
  'docs/api',
  'docs/runbooks',
];

const REQUIRED_LOGGING_SCHEMA_REFERENCES = [
  'docs/security/data-classification-policy.md',
  'scripts/tests/data-classification-guard.mjs',
];

function normalizeIdentifier(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const bannedNormalized = new Map(
  BANNED_FIELD_NAMES.map((field) => [normalizeIdentifier(field), field]),
);

function readFile(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  return fs.readFileSync(absolutePath, 'utf8');
}

function listFilesRecursively(rootPath) {
  const absoluteRoot = path.join(ROOT, rootPath);
  const entries = fs.readdirSync(absoluteRoot, { withFileTypes: true });
  const discovered = [];

  for (const entry of entries) {
    const relativePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...listFilesRecursively(relativePath));
      continue;
    }

    if (DOC_TARGET_EXTENSIONS.has(path.extname(entry.name))) {
      discovered.push(relativePath);
    }
  }

  return discovered;
}

export function collectDocTargets() {
  return DOC_TARGET_ROOTS.flatMap((rootPath) => listFilesRecursively(rootPath))
    .sort((left, right) => left.localeCompare(right));
}

function shouldIgnoreMarkdownContext(sectionHeading, listLabel) {
  const context = `${sectionHeading}\n${listLabel}`.toLowerCase();
  return (
    context.includes('prohibited') ||
    context.includes('redacted') ||
    context.includes('never place') ||
    context.includes('never log') ||
    context.includes('disallowed')
  );
}

function extractBacktickedValues(line) {
  return [...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
}

function extractMarkdownFieldNames(markdown) {
  const fieldNames = [];
  const lines = markdown.split(/\r?\n/u);
  let sectionHeading = '';
  let listLabel = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      listLabel = '';
      continue;
    }

    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/u);
    if (headingMatch) {
      sectionHeading = headingMatch[1];
      listLabel = '';
      continue;
    }

    if (!trimmed.startsWith('-') && !trimmed.startsWith('|') && trimmed.endsWith(':')) {
      listLabel = trimmed.slice(0, -1);
      continue;
    }

    if (/^\s*-\s+/u.test(line) && !shouldIgnoreMarkdownContext(sectionHeading, listLabel)) {
      fieldNames.push(...extractBacktickedValues(line));
    }

    if (/^\|/u.test(trimmed) && !shouldIgnoreMarkdownContext(sectionHeading, listLabel)) {
      fieldNames.push(...extractBacktickedValues(line));
    }
  }

  return fieldNames;
}

function extractYamlFieldNames(source) {
  const fieldNames = [];

  for (const line of source.split(/\r?\n/u)) {
    const propertyMatch = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:/u);
    if (propertyMatch) {
      fieldNames.push(propertyMatch[1]);
    }

    fieldNames.push(...extractBacktickedValues(line));
  }

  return fieldNames;
}

export function extractDocFieldNames(relativePath, source) {
  const extension = path.extname(relativePath);
  if (extension === '.yml' || extension === '.yaml') {
    return extractYamlFieldNames(source);
  }

  return extractMarkdownFieldNames(source);
}

function extractLoggerFieldNames(source) {
  const fieldNames = [];
  const interfaceMatch = source.match(/interface LogMeta \{([\s\S]*?)\n\}/u);

  if (interfaceMatch) {
    for (const line of interfaceMatch[1].split(/\r?\n/u)) {
      const propertyMatch = line.match(/^\s*([A-Za-z0-9_]+)\??:/u);
      if (propertyMatch) {
        fieldNames.push(propertyMatch[1]);
      }
    }
  }

  for (const line of source.split(/\r?\n/u)) {
    const contextMatch = line.match(/^\s*([A-Za-z0-9_]+):\s*meta\?\./u);
    if (contextMatch) {
      fieldNames.push(contextMatch[1]);
    }
  }

  return fieldNames;
}

function checkForBannedFields(targetPath, fieldNames, errors) {
  for (const fieldName of fieldNames) {
    const normalized = normalizeIdentifier(fieldName);
    const bannedSource = bannedNormalized.get(normalized);

    if (bannedSource) {
      errors.push(`${targetPath}: prohibited field surfaced in log/doc contract: ${fieldName} (matches ${bannedSource})`);
    }
  }
}

function main() {
  const errors = [];
  const docTargets = collectDocTargets();

  const policy = readFile(POLICY_PATH);
  for (const snippet of REQUIRED_POLICY_SNIPPETS) {
    if (!policy.includes(snippet)) {
      errors.push(`${POLICY_PATH}: missing required policy section/reference: ${snippet}`);
    }
  }

  const loggingSchemaPath = 'docs/observability/logging-schema.md';
  const loggingSchema = readFile(loggingSchemaPath);
  for (const snippet of REQUIRED_LOGGING_SCHEMA_REFERENCES) {
    if (!loggingSchema.includes(snippet)) {
      errors.push(`${loggingSchemaPath}: missing required classification reference: ${snippet}`);
    }
  }

  for (const relativePath of docTargets) {
    const fieldNames = extractDocFieldNames(relativePath, readFile(relativePath));
    checkForBannedFields(relativePath, fieldNames, errors);
  }

  for (const relativePath of LOGGER_TARGETS) {
    const fieldNames = extractLoggerFieldNames(readFile(relativePath));
    checkForBannedFields(relativePath, fieldNames, errors);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[FAIL] ${error}`);
    }
    process.exit(1);
  }

  console.log('Data classification guard: pass');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
