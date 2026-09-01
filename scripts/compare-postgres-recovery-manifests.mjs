#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const expectedDatabases = new Map(
  [...expectedServices].map((service) => [service, `cotsel_${service}`]),
);
const expectedMigrationTables = new Map(
  [...expectedServices].map((service) => [
    service,
    service === 'indexer' ? 'migrations' : 'cotsel_schema_migrations',
  ]),
);
const commonFields = ['service', 'database'];
const fieldsByPrefix = new Map([
  ['DATABASE_RECOVERY_TABLE', [...commonFields, 'schema', 'table', 'exact_rows', 'data_sha256']],
  ['DATABASE_RECOVERY_SEQUENCE', [...commonFields, 'schema', 'sequence', 'state_sha256']],
  [
    'DATABASE_RECOVERY_SUMMARY',
    [
      ...commonFields,
      'server_version',
      'tables',
      'sequences',
      'exact_rows',
      'migration_tables',
      'schema_sha256',
      'access_sha256',
      'data_sha256',
    ],
  ],
]);
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function requireFieldFormat(fields, field, pattern, sourceName) {
  if (!pattern.test(fields[field] ?? '')) {
    throw new Error(`${sourceName} contains invalid ${field}: ${fields[field] ?? '<missing>'}`);
  }
}

function validateRecord(prefix, fields, sourceName) {
  const expectedFields = fieldsByPrefix.get(prefix);
  assert.ok(expectedFields, `Unsupported recovery record prefix: ${prefix}`);
  assert.deepEqual(
    Object.keys(fields).sort(),
    [...expectedFields].sort(),
    `${sourceName} contains unexpected or missing fields in ${prefix}`,
  );

  if (!expectedServices.has(fields.service)) {
    throw new Error(`${sourceName} contains an unexpected service: ${fields.service}`);
  }
  if (fields.database !== expectedDatabases.get(fields.service)) {
    throw new Error(`${sourceName} contains an invalid database for ${fields.service}`);
  }

  if (prefix === 'DATABASE_RECOVERY_TABLE') {
    requireFieldFormat(fields, 'schema', identifierPattern, sourceName);
    requireFieldFormat(fields, 'table', identifierPattern, sourceName);
    requireFieldFormat(fields, 'exact_rows', unsignedIntegerPattern, sourceName);
    requireFieldFormat(fields, 'data_sha256', sha256Pattern, sourceName);
  } else if (prefix === 'DATABASE_RECOVERY_SEQUENCE') {
    requireFieldFormat(fields, 'schema', identifierPattern, sourceName);
    requireFieldFormat(fields, 'sequence', identifierPattern, sourceName);
    requireFieldFormat(fields, 'state_sha256', sha256Pattern, sourceName);
  } else {
    requireFieldFormat(fields, 'server_version', /^\d{5,6}$/, sourceName);
    for (const field of ['tables', 'sequences', 'exact_rows', 'migration_tables']) {
      requireFieldFormat(fields, field, unsignedIntegerPattern, sourceName);
    }
    for (const field of ['schema_sha256', 'access_sha256', 'data_sha256']) {
      requireFieldFormat(fields, field, sha256Pattern, sourceName);
    }
  }

  if (prefix !== 'DATABASE_RECOVERY_SUMMARY') {
    const allowedSchemas =
      fields.service === 'indexer' ? ['public', 'squid_processor'] : ['public'];
    if (!allowedSchemas.includes(fields.schema)) {
      throw new Error(`${sourceName} contains an unexpected schema for ${fields.service}`);
    }
  }
}

function parseFields(record) {
  const fields = {};
  for (const token of record.trim().split(/\s+/).slice(1)) {
    const separator = token.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Malformed recovery manifest token: ${token}`);
    }
    const name = token.slice(0, separator);
    if (Object.hasOwn(fields, name)) {
      throw new Error(`Duplicate recovery manifest field: ${name}`);
    }
    fields[name] = token.slice(separator + 1);
  }
  return fields;
}

function validateSummaryIntegrity(records, service, sourceName) {
  const database = expectedDatabases.get(service);
  const summary = records.get(`DATABASE_RECOVERY_SUMMARY:${service}:${database}`);
  if (!summary) {
    throw new Error(`${sourceName} is missing the ${service} recovery summary`);
  }

  const dataRecords = [...records.values()].filter(
    (entry) => entry.fields.service === service && entry.prefix !== 'DATABASE_RECOVERY_SUMMARY',
  );
  const tables = dataRecords.filter((entry) => entry.prefix === 'DATABASE_RECOVERY_TABLE');
  const sequences = dataRecords.filter((entry) => entry.prefix === 'DATABASE_RECOVERY_SEQUENCE');
  const exactRows = tables.reduce((total, entry) => total + Number(entry.fields.exact_rows), 0);
  const migrationTables = tables.filter((entry) => entry.fields.table.includes('migration')).length;
  const expectedDataHash = sha256(
    `${dataRecords
      .map((entry) => entry.record)
      .sort()
      .join('\n')}\n`,
  );

  const expectedValues = {
    tables: tables.length,
    sequences: sequences.length,
    exact_rows: exactRows,
    migration_tables: migrationTables,
    data_sha256: expectedDataHash,
  };
  if (
    !tables.some(
      (entry) =>
        entry.fields.schema === 'public' &&
        entry.fields.table === expectedMigrationTables.get(service),
    )
  ) {
    throw new Error(`${sourceName} is missing the expected migration ledger for ${service}`);
  }
  for (const [field, expectedValue] of Object.entries(expectedValues)) {
    if (summary.fields[field] !== String(expectedValue)) {
      throw new Error(`${sourceName} has an inconsistent ${service} ${field} summary`);
    }
  }
  if (migrationTables < 1) {
    throw new Error(`${sourceName} has no migration ledger for ${service}`);
  }
}

export function parseManifest(content, sourceName) {
  const records = new Map();
  const services = new Set();

  for (const line of content.split(/\r?\n/)) {
    const prefix = recordPrefixes.find((candidate) => line.includes(candidate));
    if (!prefix) continue;

    const record = line.slice(line.indexOf(prefix)).trim();
    const fields = parseFields(record);
    validateRecord(prefix, fields, sourceName);

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
    records.set(key, { prefix, fields, record });
  }

  assert.deepEqual(
    [...services].sort(),
    [...expectedServices].sort(),
    `${sourceName} must contain exactly the seven Cotsel services`,
  );
  for (const service of expectedServices) {
    validateSummaryIntegrity(records, service, sourceName);
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
