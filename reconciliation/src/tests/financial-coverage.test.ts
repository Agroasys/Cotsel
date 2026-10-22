import assert from 'node:assert/strict';
import test from 'node:test';
import { readFinancialCoverage } from '../core/financialCoverage';

const now = new Date('2026-10-15T12:00:00.000Z');
for (const tradeId of ['0', '7'])
  test(`reads trade ${tradeId} from only the latest complete, clean, uncontained run for the requested trade`, async () => {
    const calls: unknown[][] = [];
    const executor = {
      query: async (...args: unknown[]) => {
        calls.push(args);
        return {
          rows: [
            {
              run_key: 'retained-run',
              completed_at: now,
              chain_evidence: { version: 'cotsel.reconciliation-coverage.v1' },
            },
          ],
        };
      },
    };
    const proof = await readFinancialCoverage(executor as never, tradeId, '150', 60_000, now);
    assert.equal(proof?.runKey, 'retained-run');
    assert.equal(proof.tradeId, tradeId);
    assert.deepEqual(calls[0][1], [tradeId, '150', new Date(now.getTime() - 60_000), now]);
  });
test('rejects unproven, stale, future and invalid coverage without inventing a run', async () => {
  for (const completed of [null, new Date(now.getTime() - 60_001), new Date(now.getTime() + 1)]) {
    const executor = {
      query: async () => ({ rows: completed ? [{ completed_at: completed }] : [] }),
    };
    assert.equal(await readFinancialCoverage(executor as never, '7', '150', 60_000, now), null);
  }
  const executor = {
    query: async () => {
      throw new Error('invalid trade must not query');
    },
  };
  for (const id of ['-1', '1e3', '07', '7 OR 1=1', (1n << 256n).toString()]) {
    assert.equal(await readFinancialCoverage(executor as never, id, '150', 60_000, now), null);
  }
});
