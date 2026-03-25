#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const POLICY_PATH = 'docs/security/data-classification-policy.md';
const LOGGING_SCHEMA_PATH = 'docs/observability/logging-schema.md';

const DOC_TARGETS = [
  LOGGING_SCHEMA_PATH,
  'docs/incidents/incident-evidence-template.md',
  'docs/runbooks/operator-audit-evidence-template.md',
  'docs/runbooks/api-gateway-boundary.md',
  'docs/runbooks/dashboard-api-gateway-boundary.md',
  'docs/runbooks/reconciliation.md',
  'docs/runbooks/compliance-boundary-kyb-kyt-sanctions.md',
];

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

function extractDocFieldNames(markdown) {
  const fieldNames = [];
  const lines = markdown.split(/\r?\n/u);

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*-\s+`([^`]+)`/u);
    if (bulletMatch) {
      fieldNames.push(bulletMatch[1]);
    }

    const tableMatch = line.match(/^\|\s*`([^`]+)`\s*\|/u);
    if (tableMatch) {
      fieldNames.push(tableMatch[1]);
    }
  }

  return fieldNames;
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

  const policy = readFile(POLICY_PATH);
  for (const snippet of REQUIRED_POLICY_SNIPPETS) {
    if (!policy.includes(snippet)) {
      errors.push(`${POLICY_PATH}: missing required policy section/reference: ${snippet}`);
    }
  }

  const loggingSchema = readFile(LOGGING_SCHEMA_PATH);
  for (const snippet of REQUIRED_LOGGING_SCHEMA_REFERENCES) {
    if (!loggingSchema.includes(snippet)) {
      errors.push(`${LOGGING_SCHEMA_PATH}: missing required classification reference: ${snippet}`);
    }
  }

  for (const relativePath of DOC_TARGETS) {
    const fieldNames = extractDocFieldNames(readFile(relativePath));
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

main();
