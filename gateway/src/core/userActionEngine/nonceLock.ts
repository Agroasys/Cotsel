/** SPDX-License-Identifier: Apache-2.0 */
import type { PoolClient } from 'pg';
import { deny } from './validation';
export async function lockUserActionNonce(
  client: PoolClient,
  scope: { chainId: number; escrow: string; user: string; nonce: string },
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `user-action:${scope.chainId}:${scope.escrow}:${scope.user}:${scope.nonce}`,
  ]);
}
export async function lockUserActionRequestNonce(
  client: PoolClient,
  requestId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT chain_id::text AS "chainId",escrow_address AS escrow,user_address AS "user",authorization_nonce::text AS nonce FROM gasless_user_action_requests WHERE request_id=$1`,
    [requestId],
  );
  if (!result.rows[0]) deny('Original user-action request is required');
  await lockUserActionNonce(client, { ...result.rows[0], chainId: Number(result.rows[0].chainId) });
}
