import './helpers/reconciliationEnv';
import assert from 'node:assert/strict';
import test from 'node:test';
import { IndexerClient } from '../indexer/client';

test('independent pages preserve physical identities and distinguish an exact boundary', async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request.variables);
    return new Response(
      JSON.stringify({
        data: {
          tradeIds: [
            { id: 'a', tradeId: '7' },
            { id: 'b', tradeId: '7' },
            { id: 'c', tradeId: '999' },
          ],
        },
      }),
      { status: 200 },
    );
  });
  const page = await new IndexerClient('http://indexer.test/graphql').fetchTradeIdsPage({
    afterId: null,
    throughId: 'c',
    limit: 2,
  });
  assert.deepEqual(page, {
    records: [
      { id: 'a', tradeId: '7' },
      { id: 'b', tradeId: '7' },
    ],
    nextId: 'b',
    exhausted: false,
  });
  assert.deepEqual(requests, [{ afterId: '', throughId: 'c', limit: 3 }]);
});

test('nonmonotone physical pages fail closed', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          data: {
            tradeIds: [
              { id: 'b', tradeId: '1' },
              { id: 'a', tradeId: '2' },
            ],
          },
        }),
        { status: 200 },
      ),
  );
  await assert.rejects(
    new IndexerClient('http://indexer.test/graphql').fetchTradeIdsPage({
      afterId: null,
      throughId: 'z',
      limit: 2,
    }),
    /Invalid indexer keyset page/,
  );
});
