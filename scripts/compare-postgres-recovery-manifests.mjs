#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const expectedServices = new Set([
  'auth',
  'gateway',
  'indexer',
  'oracle',
  'reconciliation',
  'ricardian',
  'treasury',
]);
const recordPrefixes = [
  'DATABASE_RECOVERY_TABLE',
  'DATABASE_RECOVERY_SEQUENCE',
  'DATABASE_RECOVERY_SUMMARY',
];

function parseFields(record) {
  const fields = {};
  for (const token of record.trim().split(/\s+/).slice(1)) {
    const separator = token.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Malformed recovery manifest token: ${token}`);
    }
    fields[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return fields;
}

export function parseManifest(content, sourceName) {
  const records = new Map();
  const services = new Set();

  for (const line of content.split(/\r?\n/)) {
    const prefix = recordPrefixes.find((candidate) => line.includes(candidate));
    if (!prefix) continue;

    const record = line.slice(line.indexOf(prefix)).trim();
    const fields = parseFields(record);
    if (!fields.service || !fields.database) {
      throw new Error(`${sourceName} contains a recovery record without service and database`);
    }

    let key = `${prefix}:${fields.service}:${fields.database}`;
    if (prefix === 'DATABASE_RECOVERY_TABLE') {
      key = `${key}:${fields.schema}:${fields.table}`;
    } else if (prefix === 'DATABASE_RECOVERY_SEQUENCE') {
      key = `${key}:${fields.schema}:${fields.sequence}`;
    }
    if (records.has(key)) {
      throw new Error(`${sourceName} contains duplicate recovery record ${key}`);
    }

    services.add(fields.service);
    records.set(key, { prefix, fields });
  }

  assert.deepEqual(
    [...services].sort(),
    [...expectedServices].sort(),
    `${sourceName} must contain exactly the seven Cotsel services`,
  );
  for (const service of expectedServices) {
    if (!records.has(`DATABASE_RECOVERY_SUMMARY:${service}:cotsel_${service}`)) {
      throw new Error(`${sourceName} is missing the ${service} recovery summary`);
    }
  }

  return records;
}

export function compareManifests(sourceRecords, targetRecords) {
  const differences = [];
  const allKeys = new Set([...sourceRecords.keys(), ...targetRecords.keys()]);

  for (const key of [...allKeys].sort()) {
    const source = sourceRecords.get(key);
    const target = targetRecords.get(key);
    if (!source || !target) {
      differences.push({
        record: key,
        result: source ? 'missing_from_target' : 'unexpected_in_target',
      });
      continue;
    }

    const fieldNames = new Set([...Object.keys(source.fields), ...Object.keys(target.fields)]);
    const changedFields = [];
    for (const field of [...fieldNames].sort()) {
      if (source.fields[field] !== target.fields[field]) {
        changedFields.push({
          field,
          source: source.fields[field] ?? null,
          target: target.fields[field] ?? null,
        });
      }
    }
    if (changedFields.length > 0) {
      differences.push({ record: key, result: 'mismatch', fields: changedFields });
    }
  }

  return differences;
}

async function main() {
  const [sourcePath, targetPath] = process.argv.slice(2);
  if (!sourcePath || !targetPath) {
    throw new Error(
      'Usage: scripts/compare-postgres-recovery-manifests.mjs <source-log> <restored-target-log>',
    );
  }

  const [sourceContent, targetContent] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(targetPath, 'utf8'),
  ]);
  const sourceRecords = parseManifest(sourceContent, sourcePath);
  const targetRecords = parseManifest(targetContent, targetPath);
  const differences = compareManifests(sourceRecords, targetRecords);
  const report = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    classification: differences.length === 0 ? 'VERIFIED' : 'MISCONFIGURED',
    source: sourcePath,
    target: targetPath,
    comparedRecords: new Set([...sourceRecords.keys(), ...targetRecords.keys()]).size,
    differences,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (differences.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
