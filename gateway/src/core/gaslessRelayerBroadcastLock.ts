/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { GaslessRelayerBroadcastLock } from './gaslessSettlementExecutionService';

const GASLESS_RELAYER_BROADCAST_LOCK_KEY = 'gasless-relayer:broadcast';

export function createPostgresGaslessRelayerBroadcastLock(pool: Pool): GaslessRelayerBroadcastLock {
  return {
    async runExclusive(handler) {
      const client = await pool.connect();

      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [
          GASLESS_RELAYER_BROADCAST_LOCK_KEY,
        ]);
        return await handler();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
            GASLESS_RELAYER_BROADCAST_LOCK_KEY,
          ]);
        } finally {
          client.release();
        }
      }
    },
  };
}
