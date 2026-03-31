import assert from 'node:assert/strict';
import test from 'node:test';

import { persistIndexerBatch } from '../lib/persistence.js';

test('persistIndexerBatch uses idempotent upserts for replay-safe writes', async () => {
  const calls = [];
  const store = {
    async upsert(entities) {
      calls.push(entities);
    },
  };

  await persistIndexerBatch(store, {
    trades: [{ id: 'trade-1' }],
    tradeEvents: [{ id: 'trade-event-1' }],
    disputeProposals: [{ id: 'proposal-1' }],
    disputeEvents: [{ id: 'dispute-event-1' }],
    oracleUpdateProposals: [{ id: 'oracle-proposal-1' }],
    oracleEvents: [{ id: 'oracle-event-1' }],
    adminAddProposals: [{ id: 'admin-proposal-1' }],
    adminEvents: [{ id: 'admin-event-1' }],
    systemEvents: [{ id: 'system-event-1' }],
    overviewSnapshot: { id: 'overview' },
  });

  assert.equal(calls.length, 10);
  assert.deepEqual(calls.map((batch) => batch[0].id), [
    'trade-1',
    'trade-event-1',
    'proposal-1',
    'dispute-event-1',
    'oracle-proposal-1',
    'oracle-event-1',
    'admin-proposal-1',
    'admin-event-1',
    'system-event-1',
    'overview',
  ]);
});
