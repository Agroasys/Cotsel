import { validateInventoryRequest } from './inventoryValidation';
import { parseSettlementUserActionBinding } from '../settlementUserActionBinding';
/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool } from 'pg';
import type { SettlementUserActionBinding } from '../settlementUserActionBinding';
import type { GaslessTransactionIdentity } from '../gaslessTransactionOutcomeStore';
import { nonceInventory } from './retirement';
import { deny, fingerprint } from './validation';
export interface UserActionInventoryRequest {
  requestId: string;
  ownerServiceId: string;
  sourceOperationId: string;
  packageId: string;
  handoffId: string;
  requestFingerprint: string;
  bindingFingerprint: string;
  chainId: string;
  escrowAddress: string;
  userAddress: string;
  nonce: string;
  binding: SettlementUserActionBinding;
  status: 'accepted' | 'signing';
  attempts: Array<{
    event_id: string;
    event_type: string;
    transaction_hash: string | null;
    transaction_identity: GaslessTransactionIdentity | null;
  }>;
  outcomes: Array<{
    transaction_hash: string;
    observed_transaction_hash: string | null;
    outcome_status: string;
    block_number: string | null;
    block_hash: string | null;
    finality_evidence: unknown;
  }>;
}
export interface UserActionInventory {
  schemaVersion: 'cotsel.user-action-inventory.v1';
  request: UserActionInventoryRequest;
  currentNonceOwnerRequestId: string;
  inventoryFingerprint: string;
}
export type ReadUserActionInventory = (
  owner: string,
  operation: string,
) => Promise<UserActionInventory | null>;
/** Read-only service port. Owner always comes from authenticated middleware. */
export function createUserActionInventoryReader(pool: Pool): ReadUserActionInventory {
  return async (owner, operation) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query(
        `SELECT h.execution_binding AS binding,r.handoff_id AS "handoffId" FROM gasless_user_action_requests r JOIN settlement_handoffs h ON h.handoff_id=r.handoff_id WHERE r.owner_service_id=$1 AND r.source_operation_id=$2`,
        [owner, operation],
      );
      if (!result.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const { handoffId } = result.rows[0];
      const binding = parseSettlementUserActionBinding(result.rows[0].binding, owner);
      const inventory = await nonceInventory(client, {
        sourceApiKeyId: owner,
        sourceOperationId: operation,
        actionPackageId: binding.packageId,
        handoffId,
        chainId: Number(binding.chainId),
        contractAddress: binding.escrowAddress,
        userAddress: binding.signerAddress,
        userAuthorization: { nonce: binding.nonce, deadline: binding.deadline, signature: '' },
        action: binding.action,
        expiresAt: binding.expiresAt,
        tradeId: binding.tradeId,
        payloadHash: binding.executionScopeHash,
        requestId: 'inventory',
        approvalScopeFingerprint: binding.approvalScopeFingerprint,
      });
      const request = inventory.requests.find(
        (row) => row.ownerServiceId === owner && row.sourceOperationId === operation,
      ) as UserActionInventoryRequest | undefined;
      if (!request || !inventory.current) deny('Original nonce inventory is inconsistent');
      validateInventoryRequest(request, owner);
      await client.query('COMMIT');
      return {
        schemaVersion: 'cotsel.user-action-inventory.v1',
        request,
        currentNonceOwnerRequestId: inventory.current,
        inventoryFingerprint: fingerprint(request),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}
