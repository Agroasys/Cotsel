// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compatibilityProblems,
  emittedNotificationTypes,
  openApiSchemaText,
  registryProblems,
} from '../lib/event-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-event-registry-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Copies the paths the registry check reads into a scratch root. */
function copyRoot() {
  const target = fs.mkdtempSync(path.join(scratch, 'root-'));
  for (const relative of [
    'docs/api/events',
    'docs/api/cotsel-settlement-provider.openapi.yml',
    'docs/api/fixtures/cotsel-settlement-callback.v1.json',
    'oracle/src',
    'reconciliation/src',
    'indexer/src',
  ]) {
    fs.cpSync(path.join(ROOT, relative), path.join(target, relative), { recursive: true });
  }
  return target;
}

const base = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closed'] },
  },
};

test('the checked-in registry is valid and matches the emitted notification types', () => {
  assert.deepEqual(registryProblems(ROOT), []);
});

test('additive changes are compatible', () => {
  const next = structuredClone(base);
  next.properties.note = { type: 'string' };
  next.properties.status.enum.push('archived');
  next.properties.id.type = ['string', 'null'];
  assert.deepEqual(compatibilityProblems(base, next), []);
});

test('breaking changes are reported', () => {
  const cases = [
    [(s) => delete s.properties.status, /status: property removed/],
    [(s) => s.required.push('status'), /status became required/],
    [(s) => (s.properties.status.enum = ['open']), /enum value "closed" removed/],
    [(s) => (s.properties.id.type = 'number'), /type string is no longer accepted/],
    [(s) => (s.properties.status.const = 'open'), /const added/],
  ];
  for (const [mutate, problem] of cases) {
    const next = structuredClone(base);
    mutate(next);
    assert.match(compatibilityProblems(base, next).join('\n'), problem);
  }
  const open = { ...structuredClone(base), additionalProperties: true };
  assert.match(
    compatibilityProblems(open, base).join('\n'),
    /additional properties are no longer allowed/,
  );
});

test('a published schema cannot change in place', () => {
  const root = copyRoot();
  const file = path.join(root, 'docs/api/events/notification-event.v1.schema.json');
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  schema.properties.note = { type: 'string' };
  fs.writeFileSync(file, JSON.stringify(schema));
  assert.match(registryProblems(root).join('\n'), /published schema changed/);
});

test('a new version must be compatible with the previous one', () => {
  const root = copyRoot();
  const directory = path.join(root, 'docs/api/events');
  const registry = JSON.parse(fs.readFileSync(path.join(directory, 'registry.json'), 'utf8'));
  const v2 = JSON.parse(
    fs.readFileSync(path.join(directory, 'notification-event.v1.schema.json'), 'utf8'),
  );
  delete v2.properties.dedupKey;
  v2.required = v2.required.filter((name) => name !== 'dedupKey');
  fs.writeFileSync(path.join(directory, 'notification-event.v2.schema.json'), JSON.stringify(v2));
  registry.events.push({
    ...registry.events[0],
    version: 'v2',
    schema: 'notification-event.v2.schema.json',
    status: 'draft',
  });
  fs.writeFileSync(path.join(directory, 'registry.json'), JSON.stringify(registry));
  assert.match(registryProblems(root).join('\n'), /v2 breaks v1: \$\.dedupKey: property removed/);
});

test('the callback contract digest covers referenced schemas', () => {
  const root = copyRoot();
  const file = path.join(root, 'docs/api/cotsel-settlement-provider.openapi.yml');
  const yaml = fs.readFileSync(file, 'utf8');
  const blocks = [
    ...openApiSchemaText(yaml, 'CotselSettlementCallbackV1').matchAll(/^ {4}(\w+):/gmu),
  ];
  assert.ok(blocks.map((match) => match[1]).includes('SettlementObservedAmountsV1'));
  fs.writeFileSync(
    file,
    yaml.replace(
      /( {4}SettlementObservedAmountsV1:\n)/u,
      '$1      description: changed without a new version\n',
    ),
  );
  assert.match(
    registryProblems(root).join('\n'),
    /cotsel.settlement-callback.v1: published schema changed/,
  );
});

test('notification types are read from notify and raise call sites, including constants', () => {
  const source = `
    const eventType = failed ? 'ORACLE_A_FAILED' : 'ORACLE_A_EXHAUSTED';
    await this.notifier.notify({ source: 'oracle', type: eventType, severity: 'critical' });
    await this.raise({ type: gap ? 'RECONCILIATION_GAP' : 'RECONCILIATION_DRIFT' });
    // Any upper-case type literal in a notifying file counts, so the check errs towards flagging.
    const config = { type: 'NOT_AN_EVENT_ENV_NAME' };
  `;
  assert.deepEqual([...emittedNotificationTypes(source)].sort(), [
    'NOT_AN_EVENT_ENV_NAME',
    'ORACLE_A_EXHAUSTED',
    'ORACLE_A_FAILED',
    'RECONCILIATION_DRIFT',
    'RECONCILIATION_GAP',
  ]);
  assert.equal(emittedNotificationTypes("const x = { type: 'X_Y' };").size, 0);
});

test('an emitted but unregistered notification type fails the check', () => {
  const root = copyRoot();
  const file = path.join(root, 'indexer/src/alerts.ts');
  fs.appendFileSync(
    file,
    "\nexport async function extra(n) { await n.notify({ type: 'INDEXER_NEW_ALERT' }); }\n",
  );
  assert.match(
    registryProblems(root).join('\n'),
    /INDEXER_NEW_ALERT is emitted but not registered/,
  );
});
