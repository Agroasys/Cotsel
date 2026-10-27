import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkTelemetryFields, findLoggerFields } from './telemetry-field-schema-guard.mjs';

test('collects literal fields from logger calls, including nested objects', () => {
  const fields = findLoggerFields(
    'svc/src/example.ts',
    `
      Logger.info('started', { tradeId, details: { stage: 'anchor' } });
      deps.logger.error('failed', { error: 'boom', ...context });
      ctx.log.warn('lagging', { lagBlocks: 3 });
      Logger.audit('TRIGGER_APPROVED', tradeId, { actionKey });
      Logger.error('plain', error);
      metrics.info('not a logger', { ignored: true });
    `,
  ).map((field) => field.name);

  assert.deepEqual(fields, ['tradeId', 'details', 'stage', 'error', 'lagBlocks', 'actionKey']);
});

test('reports unclassified and prohibited fields with their location', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-guard-'));
  fs.mkdirSync(path.join(root, 'oracle/src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'oracle/src/leaky.ts'),
    [
      "Logger.info('ok', { tradeId: '1' });",
      "Logger.warn('bad', { buyerLegalName: name });",
      "Logger.error('worse', { privateKey: key });",
    ].join('\n'),
  );

  const { errors, fieldCount } = checkTelemetryFields(root);

  assert.equal(fieldCount, 3);
  assert.deepEqual(errors, [
    'oracle/src/leaky.ts:2: field "buyerLegalName" is not classified in shared-telemetry/fieldPolicy.js',
    'oracle/src/leaky.ts:3: prohibited field "privateKey" passed to a logger',
  ]);
});

test('every logger field in the repository is classified', () => {
  const { errors, fieldCount } = checkTelemetryFields();
  assert.deepEqual(errors, []);
  assert.ok(fieldCount > 300, `expected the full logger inventory, saw ${fieldCount}`);
});
