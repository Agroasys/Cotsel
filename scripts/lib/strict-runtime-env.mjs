#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// These additive capability dependencies alone may be absent from an older runtime profile.
const OPTIONAL_EMPTY_RUNTIME_KEYS = new Set([
  'GATEWAY_USER_ACTION_RETIREMENT_EVIDENCE_URL',
  'GATEWAY_USER_ACTION_RETIREMENT_OWNING_SERVICE_ID',
  'ORACLE_NOTIFICATIONS_ESCALATION_WEBHOOK_URL',
  'RECONCILIATION_NOTIFICATIONS_ESCALATION_WEBHOOK_URL',
  'INDEXER_NOTIFICATIONS_ESCALATION_WEBHOOK_URL',
]);
const SHELL_EXPRESSION_PATTERN = /\$\{|\$\(|`/;
const SENSITIVE_KEY_PATTERN =
  /(PASSWORD|SECRET|PRIVATE|TOKEN|API_KEY|API_KEYS|HMAC|WEBHOOK_URL|RPC(?:_FALLBACK)?(?:_URL|_URLS|_ENDPOINT|_ENDPOINTS)|DATABASE_URL|REDIS_URL)$/;

function fail(message) {
  throw new Error(message);
}

function parseQuotedValue(raw, quote, source, lineNumber) {
  let escaped = false;
  let closingIndex = -1;

  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) {
      closingIndex = index;
      break;
    }
    escaped = false;
  }

  if (closingIndex === -1 || raw.slice(closingIndex + 1).trim() !== '') {
    fail(`${source}:${lineNumber}: quoted value is not terminated cleanly`);
  }

  const value = raw.slice(1, closingIndex);
  if (quote === "'") {
    return value;
  }

  return value.replace(/\\([\\"nrt])/g, (_match, escapedCharacter) => {
    const replacements = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };
    return replacements[escapedCharacter];
  });
}

export function parseStrictEnv(text, source = '<environment>') {
  const values = new Map();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = lines[index].trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    if (trimmed.startsWith('export ')) {
      fail(`${source}:${lineNumber}: export syntax is not allowed`);
    }

    const separatorIndex = lines[index].indexOf('=');
    if (separatorIndex < 1) {
      fail(`${source}:${lineNumber}: expected KEY=VALUE`);
    }

    const key = lines[index].slice(0, separatorIndex).trim();
    if (!KEY_PATTERN.test(key)) {
      fail(`${source}:${lineNumber}: invalid environment key ${JSON.stringify(key)}`);
    }
    if (values.has(key)) {
      fail(`${source}:${lineNumber}: duplicate environment key ${key}`);
    }

    const rawValue = lines[index].slice(separatorIndex + 1).trim();
    let value;
    if (rawValue.startsWith("'") || rawValue.startsWith('"')) {
      value = parseQuotedValue(rawValue, rawValue[0], source, lineNumber);
    } else {
      if (/\s/.test(rawValue)) {
        fail(`${source}:${lineNumber}: values containing whitespace must be quoted`);
      }
      if (SHELL_EXPRESSION_PATTERN.test(rawValue)) {
        fail(`${source}:${lineNumber}: variable and command expansion syntax is not allowed`);
      }
      value = rawValue;
    }

    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      fail(`${source}:${lineNumber}: multiline and NUL values are not supported`);
    }
    values.set(key, value);
  }

  return values;
}

export function loadStrictRuntimeEnv({ envFile, schemaFile, inheritedEnv = process.env }) {
  const schema = parseStrictEnv(readFileSync(schemaFile, 'utf8'), schemaFile);
  const values = parseStrictEnv(readFileSync(envFile, 'utf8'), envFile);

  for (const key of values.keys()) {
    if (!schema.has(key)) {
      fail(`${envFile}: unknown environment key ${key}`);
    }
  }

  for (const key of schema.keys()) {
    if (!values.has(key)) {
      if (OPTIONAL_EMPTY_RUNTIME_KEYS.has(key) && schema.get(key) === '') {
        values.set(key, '');
        continue;
      }
      fail(`${envFile}: missing environment key ${key}`);
    }
  }

  for (const [key, value] of values) {
    if (
      Object.prototype.hasOwnProperty.call(inheritedEnv, key) &&
      inheritedEnv[key] !== value
    ) {
      fail(`${envFile}: inherited override for ${key} is prohibited`);
    }
  }

  const redactedEntries = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!SENSITIVE_KEY_PATTERN.test(key)) {
        return `${key}=${value}`;
      }
      return `${key}=<redacted:${value === '' ? 'empty' : 'present'}>`;
    });
  const redactedConfigSha256 = createHash('sha256')
    .update(`${redactedEntries.join('\n')}\n`)
    .digest('hex');

  return { values, redactedConfigSha256 };
}

function parseArguments(argv) {
  const args = { envFile: '.env.runtime', schemaFile: '.env.runtime.example', emitHex: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env-file') {
      args.envFile = argv[++index];
    } else if (argument === '--schema') {
      args.schemaFile = argv[++index];
    } else if (argument === '--emit-hex') {
      args.emitHex = true;
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  if (!args.envFile || !args.schemaFile) {
    fail('--env-file and --schema require paths');
  }
  return args;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const envFile = path.resolve(args.envFile);
  const schemaFile = path.resolve(args.schemaFile);
  const { values, redactedConfigSha256 } = loadStrictRuntimeEnv({ envFile, schemaFile });

  if (args.emitHex) {
    for (const [key, value] of values) {
      process.stdout.write(`${key}\t${Buffer.from(value, 'utf8').toString('hex')}\n`);
    }
    process.stdout.write(`COTSEL_REDACTED_CONFIG_SHA256\t${Buffer.from(redactedConfigSha256).toString('hex')}\n`);
    return;
  }

  process.stdout.write(`${redactedConfigSha256}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`strict runtime environment rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}
