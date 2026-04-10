#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const RULES_VERSION = 'RICARDIAN_CANONICAL_V1';

function usage() {
  console.error(
    [
      'Usage:',
      '  node scripts/reproduce-ricardian-hash.mjs --payload-file <path> [--pretty]',
      '  node scripts/reproduce-ricardian-hash.mjs --document-ref <ref> --terms-file <path> [--metadata-file <path>] [--pretty]',
      '',
      'Notes:',
      '  - Output hash is deterministic for identical documentRef/terms/metadata inputs.',
      '  - requestId is not part of the hash preimage and is intentionally omitted from output.',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const opts = {
    pretty: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--pretty') {
      opts.pretty = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }

    if (arg === '--payload-file') {
      opts.payloadFile = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--document-ref') {
      opts.documentRef = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--terms-file') {
      opts.termsFile = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--metadata-file') {
      opts.metadataFile = argv[i + 1];
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function readJsonFile(filePath, label) {
  if (!filePath) {
    throw new Error(`${label} is required`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} (${filePath}): ${error.message}`, { cause: error });
  }
}

function assertFiniteNumber(value) {
  if (!Number.isFinite(value)) {
    throw new Error('Non-finite numbers are not supported in Ricardian canonicalization');
  }
}

function canonicalize(value) {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    assertFiniteNumber(value);
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (typeof value === 'object') {
    const result = Object.create(null);
    const sortedKeys = Object.keys(value).sort();
    for (const key of sortedKeys) {
      const raw = value[key];
      if (raw === undefined) {
        continue;
      }

      Object.defineProperty(result, key, {
        value: canonicalize(raw),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }

  throw new Error(`Unsupported value type in Ricardian payload: ${typeof value}`);
}

function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function buildPayload(opts) {
  if (opts.payloadFile) {
    const payload = readJsonFile(opts.payloadFile, '--payload-file');
    if (!payload || typeof payload !== 'object') {
      throw new Error('--payload-file must contain an object');
    }
    return payload;
  }

  const terms = readJsonFile(opts.termsFile, '--terms-file');
  const metadata = opts.metadataFile
    ? readJsonFile(opts.metadataFile, '--metadata-file')
    : undefined;

  return {
    documentRef: opts.documentRef,
    terms,
    metadata,
  };
}

function buildRicardianHash(payload) {
  if (!payload.documentRef || payload.documentRef.trim().length === 0) {
    throw new Error('documentRef is required');
  }

  if (!payload.terms || typeof payload.terms !== 'object') {
    throw new Error('terms must be an object');
  }

  const metadata = payload.metadata || {};
  const canonicalPayload = {
    documentRef: payload.documentRef,
    metadata,
    terms: payload.terms,
  };

  const canonicalJson = canonicalJsonStringify(canonicalPayload);
  const preimage = `${RULES_VERSION}:${canonicalJson}`;
  const hash = createHash('sha256').update(preimage).digest('hex');

  return {
    documentRef: payload.documentRef,
    rulesVersion: RULES_VERSION,
    canonicalJson,
    preimage,
    hash,
    metadata,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    process.exit(0);
  }

  if (!opts.payloadFile && (!opts.documentRef || !opts.termsFile)) {
    usage();
    process.exit(1);
  }

  const payload = buildPayload(opts);
  const result = buildRicardianHash(payload);
  process.stdout.write(`${JSON.stringify(result, null, opts.pretty ? 2 : 0)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
