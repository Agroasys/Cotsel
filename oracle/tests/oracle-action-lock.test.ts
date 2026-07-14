import type { Pool, PoolClient, QueryResult } from 'pg';
import { createPostgresOracleActionLock } from '../src/core/oracle-action-lock';

function queryResult<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe('Postgres oracle action lock', () => {
  test('holds the same action lock for the complete financial operation', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([{ unlocked: true }]));
    const release = jest.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const lock = createPostgresOracleActionLock(pool);
    const work = jest.fn().mockResolvedValue('completed');

    await expect(lock.withLock('FINAL_RELEASE:42', work)).resolves.toBe('completed');

    expect(query.mock.calls[0]).toEqual([
      'SELECT pg_advisory_lock($1, hashtext($2))',
      [91308, 'FINAL_RELEASE:42'],
    ]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[1]).toEqual([
      'SELECT pg_advisory_unlock($1, hashtext($2)) AS unlocked',
      [91308, 'FINAL_RELEASE:42'],
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('releases the advisory lock when execution fails', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([{ unlocked: true }]));
    const release = jest.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const lock = createPostgresOracleActionLock(pool);

    await expect(
      lock.withLock('FINAL_RELEASE:42', async () => {
        throw new Error('submission failed');
      }),
    ).rejects.toThrow('submission failed');

    expect(query).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
