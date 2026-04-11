import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEvmEventId, compareOrderedEvmEvents } from '../lib/eventIdentity.js';

test('buildEvmEventId uses canonical txHash-logIndex identity', () => {
  assert.equal(buildEvmEventId('0xabc', 7), '0xabc-7');
});

test('compareOrderedEvmEvents sorts deterministically by block, tx, log, id', () => {
  const events = [
    { id: 'b', blockNumber: 100, transactionIndex: 2, logIndex: 0 },
    { id: 'a', blockNumber: 100, transactionIndex: 2, logIndex: 0 },
    { id: 'c', blockNumber: 101, transactionIndex: 0, logIndex: 0 },
    { id: 'd', blockNumber: 100, transactionIndex: 1, logIndex: 9 },
    { id: 'e', blockNumber: 100, transactionIndex: 1, logIndex: 1 },
  ];

  const sorted = [...events].sort(compareOrderedEvmEvents);

  assert.deepEqual(
    sorted.map((event) => event.id),
    ['e', 'd', 'a', 'b', 'c'],
  );
});
