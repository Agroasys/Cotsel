import type { Pool, PoolClient } from 'pg';
import { Logger } from '../utils/logger';

const ORACLE_ACTION_LOCK_NAMESPACE = 91308;

export interface OracleActionLock {
  withLock<T>(actionKey: string, work: () => Promise<T>): Promise<T>;
}

export const NOOP_ORACLE_ACTION_LOCK: OracleActionLock = {
  withLock: async <T>(_actionKey: string, work: () => Promise<T>): Promise<T> => work(),
};

async function releaseLock(client: PoolClient, actionKey: string): Promise<void> {
  const result = await client.query<{ unlocked: boolean }>(
    'SELECT pg_advisory_unlock($1, hashtext($2)) AS unlocked',
    [ORACLE_ACTION_LOCK_NAMESPACE, actionKey],
  );

  if (!result.rows[0]?.unlocked) {
    Logger.error('Oracle action advisory lock was not held during release', { actionKey });
  }
}

export function createPostgresOracleActionLock(pool: Pool): OracleActionLock {
  return {
    async withLock<T>(actionKey: string, work: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let acquired = false;

      try {
        await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [
          ORACLE_ACTION_LOCK_NAMESPACE,
          actionKey,
        ]);
        acquired = true;
        return await work();
      } finally {
        try {
          if (acquired) {
            await releaseLock(client, actionKey);
          }
        } finally {
          client.release();
        }
      }
    },
  };
}
