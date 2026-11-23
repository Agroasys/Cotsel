// SPDX-License-Identifier: Apache-2.0
// Event schema registry checks (#949). Published schema versions are frozen by
// digest; a new version must emit only values accepted by existing consumers.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalDigest } from './release-evidence-validation.mjs';

const VERSION_PATTERN = /^v([1-9][0-9]*)$/u;
// Existing value constraints cannot disappear. Changed bounds require review,
// even if they might narrow the new producer's output.
const CONSTRAINT_KEYWORDS = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
];

const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/**
 * Consumer compatibility: every value accepted by `next` must be accepted by
 * `previous`. Producers may narrow their output, but must not widen it.
 * Covers the JSON Schema subset the registry uses: type, enum, const,
 * properties, required, additionalProperties, items and value constraints
 * (CONSTRAINT_KEYWORDS). It is deliberately conservative: a changed bound is
 * reported even when it widens, so a person decides.
 */
export function compatibilityProblems(previous, next, at = '$') {
  const problems = [];
  if (next === false || previous === true) return problems;
  if (previous === false) return next === false ? [] : [`${at}: rejecting schema widened`];
  if (next === true) next = {};
  if (!previous || typeof previous !== 'object') return problems;
  if (!next || typeof next !== 'object') return [`${at}: schema removed`];

  const previousTypes = new Set(asArray(previous.type));
  const nextTypes = asArray(next.type);
  if (previousTypes.size && !nextTypes.length) problems.push(`${at}: type constraint removed`);
  if (previousTypes.size && nextTypes.length) {
    for (const type of nextTypes) {
      if (!previousTypes.has(type) && !(type === 'integer' && previousTypes.has('number'))) {
        problems.push(`${at}: type ${type} is newly emitted`);
      }
    }
  }
  for (const keyword of CONSTRAINT_KEYWORDS) {
    if (
      previous[keyword] !== undefined &&
      JSON.stringify(next[keyword]) !== JSON.stringify(previous[keyword])
    ) {
      problems.push(`${at}: ${keyword} removed or changed`);
    }
  }
  const previousValues = previous.const !== undefined ? [previous.const] : previous.enum;
  const nextValues = next.const !== undefined ? [next.const] : next.enum;
  if (Array.isArray(previousValues)) {
    if (!Array.isArray(nextValues)) {
      problems.push(`${at}: enum or const constraint removed`);
    } else {
      for (const value of nextValues) {
        if (!previousValues.some((old) => JSON.stringify(old) === JSON.stringify(value))) {
          problems.push(`${at}: enum value ${JSON.stringify(value)} is newly emitted`);
        }
      }
    }
  }
  const nextRequired = new Set(next.required ?? []);
  for (const name of previous.required ?? []) {
    if (!nextRequired.has(name)) problems.push(`${at}: ${name} is no longer required`);
  }
  for (const [name, schema] of Object.entries(previous.properties ?? {})) {
    const nextSchema = next.properties?.[name] ?? next.additionalProperties;
    if (nextSchema === false) continue;
    problems.push(...compatibilityProblems(schema, nextSchema ?? {}, `${at}.${name}`));
  }
  for (const [name, schema] of Object.entries(next.properties ?? {})) {
    if (name in (previous.properties ?? {})) continue;
    if (previous.additionalProperties === false) {
      problems.push(`${at}.${name}: property added to a closed object`);
    } else if (typeof previous.additionalProperties === 'object') {
      problems.push(
        ...compatibilityProblems(previous.additionalProperties, schema, `${at}.${name}`),
      );
    }
  }
  if (previous.additionalProperties === false && next.additionalProperties !== false) {
    problems.push(`${at}: additional properties are newly allowed`);
  }
  if (previous.items)
    problems.push(...compatibilityProblems(previous.items, next.items ?? {}, `${at}[]`));
  if (
    previous.additionalProperties &&
    typeof previous.additionalProperties === 'object' &&
    next.additionalProperties !== false
  ) {
    problems.push(
      ...compatibilityProblems(
        previous.additionalProperties,
        next.additionalProperties ?? {},
        `${at}{*}`,
      ),
    );
  }
  return problems;
}

/**
 * Extracts a named schema from an OpenAPI YAML document as text, together
 * with every schema it references, so the frozen digest also changes when a
 * referenced schema changes. Expects schemas indented by four spaces under
 * `components.schemas`, as in this repository.
 */
export function openApiSchemaText(yaml, name) {
  const lines = yaml.split('\n');
  const blocks = new Map();
  let current = null;
  for (const line of lines) {
    const header = /^ {4}([A-Za-z0-9_]+):\s*$/u.exec(line);
    if (header) {
      current = header[1];
      blocks.set(current, [line]);
    } else if (current && (line.startsWith('      ') || line.trim() === '')) {
      blocks.get(current).push(line);
    } else {
      current = null;
    }
  }
  if (!blocks.has(name)) throw new Error(`OpenAPI schema ${name} not found`);
  const seen = new Set();
  const order = [];
  const visit = (schemaName) => {
    if (seen.has(schemaName)) return;
    if (!blocks.has(schemaName)) throw new Error(`OpenAPI schema ${schemaName} not found`);
    seen.add(schemaName);
    order.push(schemaName);
    const text = blocks.get(schemaName).join('\n');
    for (const match of text.matchAll(/\$ref: '#\/components\/schemas\/([A-Za-z0-9_]+)'/gu)) {
      visit(match[1]);
    }
  };
  visit(name);
  return order
    .sort()
    .map((schemaName) => blocks.get(schemaName).join('\n').trimEnd())
    .join('\n');
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Notification types raised at notify(...) / raise(...) call sites. Resolves a
 * `type: identifier` to the literals assigned to that identifier in the same
 * file, which covers the ternaries the producers use.
 */
export function emittedNotificationTypes(source) {
  if (!/\.notify\(|\.raise\(/u.test(source)) return new Set();
  const found = new Set();
  const literals = (expression) =>
    [...expression.matchAll(/'([A-Z][A-Z0-9_]+)'/gu)].map((match) => match[1]);
  for (const match of source.matchAll(/\btype:\s*([^,\n}]+)/gu)) {
    const expression = match[1].trim();
    if (expression.includes("'")) {
      literals(expression).forEach((value) => found.add(value));
    } else if (/^[A-Za-z_$][\w$]*$/u.test(expression)) {
      const assignment = new RegExp(
        `(?:const|let)\\s+${expression}\\s*=\\s*([\\s\\S]*?);`,
        'u',
      ).exec(source);
      if (assignment) literals(assignment[1]).forEach((value) => found.add(value));
    }
  }
  return found;
}

function listSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

/** Validates the checked-in registry against the repository. Returns problems. */
export function registryProblems(root) {
  const problems = [];
  const directory = path.join(root, 'docs/api/events');
  const registry = JSON.parse(fs.readFileSync(path.join(directory, 'registry.json'), 'utf8'));
  const loadSchema = (file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));

  if (registry.schemaVersion !== 'cotsel.event-registry.v1')
    problems.push('registry schemaVersion');

  const frozen = (label, entry, digest) => {
    if (entry.status === 'draft') return;
    if (entry.sha256 !== digest) {
      problems.push(
        `${label}: published schema changed (expected ${entry.sha256}, found ${digest}); publish a new version instead`,
      );
    }
  };

  frozen('envelope', registry.envelope, canonicalDigest(loadSchema(registry.envelope.schema)));

  const byType = new Map();
  for (const event of registry.events) {
    if (!VERSION_PATTERN.test(event.version))
      problems.push(`${event.type}: bad version ${event.version}`);
    const schema = loadSchema(event.schema);
    frozen(`${event.type} ${event.version}`, event, canonicalDigest(schema));
    if (!byType.has(event.type)) byType.set(event.type, []);
    byType.get(event.type).push({ ...event, document: schema });
  }
  for (const [type, versions] of byType) {
    versions.sort(
      (a, b) =>
        Number(VERSION_PATTERN.exec(a.version)[1]) - Number(VERSION_PATTERN.exec(b.version)[1]),
    );
    versions.forEach((entry, index) => {
      if (Number(VERSION_PATTERN.exec(entry.version)[1]) !== index + 1) {
        problems.push(`${type}: versions must be consecutive from v1`);
      }
      if (index > 0) {
        for (const problem of compatibilityProblems(versions[index - 1].document, entry.document)) {
          problems.push(
            `${type} ${entry.version} breaks ${versions[index - 1].version}: ${problem}`,
          );
        }
      }
    });
  }

  for (const contract of registry.contracts ?? []) {
    const yaml = fs.readFileSync(path.join(root, contract.openapi), 'utf8');
    frozen(contract.id, contract, sha256(openApiSchemaText(yaml, contract.schema)));
    const fixture = JSON.parse(fs.readFileSync(path.join(root, contract.fixture), 'utf8'));
    if (fixture.contractVersion !== contract.id) {
      problems.push(`${contract.id}: fixture declares ${fixture.contractVersion}`);
    }
  }

  const notification = byType.get('cotsel.notification');
  if (notification) {
    const latest = notification.at(-1);
    const registered = new Set(latest.document.properties.type.enum);
    const emitted = new Set();
    for (const producer of latest.producers) {
      for (const file of listSourceFiles(path.join(root, producer, 'src'))) {
        emittedNotificationTypes(fs.readFileSync(file, 'utf8')).forEach((type) =>
          emitted.add(type),
        );
      }
    }
    for (const type of emitted) {
      if (!registered.has(type))
        problems.push(`notification type ${type} is emitted but not registered`);
    }
    // The producer library carries its own copy of the registered types; keep it in step.
    const envelopeSource = path.join(root, 'notifications/src/envelope.ts');
    if (fs.existsSync(envelopeSource)) {
      const declared = registeredTypesDeclaredIn(fs.readFileSync(envelopeSource, 'utf8'));
      const expected = [...registered].sort();
      if (JSON.stringify([...declared].sort()) !== JSON.stringify(expected)) {
        problems.push(
          `notifications/src/envelope.ts REGISTERED_NOTIFICATION_TYPES differs from the registry (${[...declared].sort().join(', ')} vs ${expected.join(', ')})`,
        );
      }
    }
  }
  return problems;
}

/** Reads the REGISTERED_NOTIFICATION_TYPES array literal from the producer library. */
export function registeredTypesDeclaredIn(source) {
  const match = /REGISTERED_NOTIFICATION_TYPES\s*=\s*\[([\s\S]*?)\]/u.exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/'([A-Z][A-Z0-9_]+)'/gu)].map((entry) => entry[1]);
}
