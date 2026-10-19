import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadStrictRuntimeEnv, parseStrictEnv } from '../lib/strict-runtime-env.mjs';

test('parses literal quoted values without executing shell syntax', () => {
  const values = parseStrictEnv("NETWORK='Base Sepolia'\nLITERAL='$HOME'\n", 'fixture');
  assert.equal(values.get('NETWORK'), 'Base Sepolia');
  assert.equal(values.get('LITERAL'), '$HOME');
});

test('rejects duplicate, executable, and ambiguous values', () => {
  assert.throws(() => parseStrictEnv('A=one\nA=two\n', 'fixture'), /duplicate environment key A/);
  assert.throws(() => parseStrictEnv('export A=one\n', 'fixture'), /export syntax is not allowed/);
  assert.throws(() => parseStrictEnv('A=$(touch owned)\n', 'fixture'), /whitespace must be quoted/);
  assert.throws(() => parseStrictEnv('A=${OTHER}\n', 'fixture'), /expansion syntax is not allowed/);
  assert.throws(() => parseStrictEnv('A=two words\n', 'fixture'), /whitespace must be quoted/);
});

test('rejects unknown keys and inherited configuration overrides', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cotsel-strict-env-'));
  const schemaFile = path.join(directory, 'schema.env');
  const envFile = path.join(directory, 'runtime.env');
  writeFileSync(schemaFile, 'KNOWN=\n');
  writeFileSync(envFile, 'UNKNOWN=value\n');
  assert.throws(
    () => loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} }),
    /unknown environment key UNKNOWN/,
  );

  writeFileSync(schemaFile, 'KNOWN=\nREQUIRED_EVEN_WHEN_EMPTY=\n');
  writeFileSync(envFile, 'KNOWN=file-value\n');
  assert.throws(
    () =>
      loadStrictRuntimeEnv({
        envFile,
        schemaFile,
        inheritedEnv: { REQUIRED_EVEN_WHEN_EMPTY: 'ambient-value' },
      }),
    /missing environment key REQUIRED_EVEN_WHEN_EMPTY/,
  );

  writeFileSync(schemaFile, 'KNOWN=\n');
  writeFileSync(envFile, 'KNOWN=file-value\n');
  assert.throws(
    () => loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: { KNOWN: 'ambient-value' } }),
    /inherited override for KNOWN is prohibited/,
  );

  assert.doesNotThrow(() =>
    loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: { KNOWN: 'file-value' } }),
  );
});

test('produces a deterministic digest from redacted configuration', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cotsel-config-digest-'));
  const schemaFile = path.join(directory, 'schema.env');
  const envFile = path.join(directory, 'runtime.env');
  writeFileSync(schemaFile, 'MODE=\nAPI_SECRET=\n');
  writeFileSync(envFile, 'MODE=staging\nAPI_SECRET=first-secret\n');
  const first = loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} });

  writeFileSync(envFile, 'API_SECRET=rotated-secret\nMODE=staging\n');
  const reorderedAndRotated = loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} });
  assert.equal(first.redactedConfigSha256, reorderedAndRotated.redactedConfigSha256);

  writeFileSync(envFile, 'MODE=production\nAPI_SECRET=rotated-secret\n');
  const changedPublicConfig = loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} });
  assert.notEqual(first.redactedConfigSha256, changedPublicConfig.redactedConfigSha256);
});

test('exactly two additive retirement dependencies may be absent from old profiles', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cotsel-optional-retirement-'));
  const schemaFile = path.join(directory, 'schema.env');
  const envFile = path.join(directory, 'runtime.env');
  const url = 'GATEWAY_USER_ACTION_RETIREMENT_EVIDENCE_URL';
  const owner = 'GATEWAY_USER_ACTION_RETIREMENT_OWNING_SERVICE_ID';
  writeFileSync(schemaFile, `REQUIRED=\n${url}=\n${owner}=\n`);
  writeFileSync(envFile, 'REQUIRED=retained\n');
  const legacy = loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} });
  assert.equal(legacy.values.get(url), '');
  assert.equal(legacy.values.get(owner), '');
  writeFileSync(envFile, `REQUIRED=retained\n${url}=\n${owner}=\n`);
  assert.equal(
    loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} }).redactedConfigSha256,
    legacy.redactedConfigSha256,
  );
  writeFileSync(
    envFile,
    `REQUIRED=retained\n${url}=https://backend.example.test/api/v1/settlement-handoffs/cotsel/lifecycle-action-retirement-evidence\n`,
  );
  const partial = loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} });
  assert.equal(partial.values.get(owner), '');
  assert.throws(
    () => loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: { [owner]: 'ambient-owner' } }),
    /inherited override/,
  );
  writeFileSync(envFile, `${url}=\n${owner}=\n`);
  assert.throws(
    () => loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} }),
    /missing environment key REQUIRED/,
  );
  writeFileSync(schemaFile, `REQUIRED=\n${url}=https://invented-default.example.test\n${owner}=\n`);
  writeFileSync(envFile, 'REQUIRED=retained\n');
  assert.throws(
    () => loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv: {} }),
    /missing environment key GATEWAY_USER_ACTION_RETIREMENT_EVIDENCE_URL/,
  );
});
