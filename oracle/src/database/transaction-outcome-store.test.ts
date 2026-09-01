import type { Pool } from 'pg';
import { createPostgresOracleTransactionOutcomeStore } from './transaction-outcome-store';

test('keeps every nonterminal outcome in the restart recovery query', async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const store = createPostgresOracleTransactionOutcomeStore({ query } as unknown as Pool);

  await store.listRecoveryCandidates(25);

  expect(query).toHaveBeenCalledTimes(1);
  const [sql, values] = query.mock.calls[0];
  expect(sql).toContain("'broadcast_pending', 'broadcast_unknown', 'confirmation_pending'");
  expect(values).toEqual([25]);
});
