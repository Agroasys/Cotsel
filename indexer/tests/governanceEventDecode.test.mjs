import assert from 'node:assert/strict';
import test from 'node:test';

import { contractInterface } from '../lib/abi.js';

test('ABI decodes unified administrator-change proposals', () => {
  const fragment = contractInterface.getEvent('AdminChangeProposed');
  const encoded = contractInterface.encodeEventLog(fragment, [
    7n,
    '0x1111111111111111111111111111111111111111',
    2,
    '0x2222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333',
    0n,
    1_800_000_000n,
    4n,
  ]);

  const decoded = contractInterface.parseLog(encoded);
  assert.equal(decoded?.name, 'AdminChangeProposed');
  assert.equal(decoded?.args.proposalId, 7n);
  assert.equal(decoded?.args.kind, 2n);
  assert.equal(decoded?.args.epoch, 4n);
});

test('ABI decodes scoped recovery with its incident reference and epoch', () => {
  const fragment = contractInterface.getEvent('UnpauseProposed');
  const incidentRef = `0x${'ab'.repeat(32)}`;
  const encoded = contractInterface.encodeEventLog(fragment, [
    '0x1111111111111111111111111111111111111111',
    2,
    42n,
    incidentRef,
    5n,
  ]);

  const decoded = contractInterface.parseLog(encoded);
  assert.equal(decoded?.name, 'UnpauseProposed');
  assert.equal(decoded?.args.scope, 2n);
  assert.equal(decoded?.args.tradeId, 42n);
  assert.equal(decoded?.args.incidentRef, incidentRef);
  assert.equal(decoded?.args.epoch, 5n);
});
