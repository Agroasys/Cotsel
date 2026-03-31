import assert from 'node:assert/strict';
import test from 'node:test';

import { contractInterface } from '../lib/abi.js';
import { ESCROW_EVENT_SIGNATURES, ESCROW_EVENT_TOPICS } from '../lib/eventTopics.js';

test('active processor topics are derived from the frozen escrow ABI', () => {
  const abiEventSignatures = contractInterface.fragments
    .filter((fragment) => fragment.type === 'event')
    .map((fragment) => fragment.format('sighash'))
    .sort();

  assert.deepEqual(ESCROW_EVENT_SIGNATURES, abiEventSignatures);
  assert.equal(ESCROW_EVENT_TOPICS.length, abiEventSignatures.length);
});
