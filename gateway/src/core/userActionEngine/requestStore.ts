import { lockUserActionNonce, lockUserActionRequestNonce } from './nonceLock';
/** SPDX-License-Identifier: Apache-2.0 */
import { validateSignedIdentity } from './signedIdentity';
import { nonceInventory } from './retirement';
import type { GaslessTransactionIdentity } from '../gaslessTransactionOutcomeStore';
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type { GaslessUserActionExecutionInput } from '../gaslessExecutionTypes';
import type { SettlementHandoffRecord } from '../settlementStore';
import {
  assertDormantAction,
  deny,
  fingerprint,
  handoffSnapshot,
  requestIdentity,
  type UserActionWitness,
} from './validation';

export interface UserActionRequest {
  requestId: string;
  status: 'accepted' | 'signing';
  requestFingerprint: string;
}
export interface UserActionClaim {
  requestId: string;
  token: string;
}
export interface UserActionReplay {
  requestId: string;
  status: 'accepted' | 'signing';
  attempts: Array<{ eventType: string; transactionHash: string | null }>;
  outcomes: Array<{
    transactionHash: string;
    observedTransactionHash: string | null;
    outcomeStatus: string;
  }>;
}
export interface UserActionRequestStore {
  accept(
    input: GaslessUserActionExecutionInput,
    witness: UserActionWitness,
  ): Promise<UserActionRequest>;
  claim(request: UserActionRequest): Promise<UserActionClaim>;
  beginSigning(
    input: GaslessUserActionExecutionInput,
    witness: UserActionWitness,
    claim: UserActionClaim,
  ): Promise<void>;
  recordSigned(claim: UserActionClaim, identity: GaslessTransactionIdentity): Promise<void>;
  recordHash(
    claim: UserActionClaim,
    type: 'provider_hash' | 'signer_rejected',
    hash: string,
  ): Promise<void>;
  matches(input: GaslessUserActionExecutionInput): Promise<boolean>;
  inspect(owner: string, operation: string): Promise<UserActionReplay | null>;
}
const projection = `request_id AS "requestId",execution_status AS status,request_fingerprint AS "requestFingerprint"`;
export function createUserActionRequestStore(
  pool: Pool,
  leaseSeconds = 60,
  now: () => number = Date.now,
): UserActionRequestStore {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1)
    throw new Error('Positive user-action lease required');
  async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function lockedWitness(
    client: PoolClient,
    input: GaslessUserActionExecutionInput,
    witness: UserActionWitness,
  ) {
    assertDormantAction(input);
    const identity = requestIdentity(input);
    await lockUserActionNonce(client, identity);
    const inventory = await nonceInventory(client, input);
    if (fingerprint(inventory) !== witness.ownership.snapshot)
      deny('Nonce ownership preflight changed');
    if (now() < witness.checkedAt || now() - witness.checkedAt > 10_000)
      deny('User-action preflight expired');
    const row = await client.query<SettlementHandoffRecord>(
      `SELECT source_api_key_id AS "sourceApiKeyId",phase,settlement_channel AS "settlementChannel",trade_id AS "tradeId",external_reference AS "externalReference",execution_binding AS "executionBinding",execution_status AS "executionStatus" FROM settlement_handoffs WHERE handoff_id=$1 FOR UPDATE`,
      [input.handoffId],
    );
    const handoff = row.rows[0];
    // Repeat freshness AFTER lock contention; never refresh inside the transaction.
    if (
      !handoff ||
      now() < witness.checkedAt ||
      now() - witness.checkedAt > 10_000 ||
      handoffSnapshot(handoff) !== witness.snapshot ||
      fingerprint(await nonceInventory(client, input)) !== witness.ownership.snapshot ||
      fingerprint(handoff.executionBinding) !== witness.bindingFingerprint ||
      handoff.sourceApiKeyId !== input.sourceApiKeyId ||
      handoff.externalReference !== input.sourceOperationId ||
      !['pending', 'accepted', 'queued'].includes(handoff.executionStatus)
    )
      deny('User-action preflight changed');
  }
  async function event(
    client: PoolClient,
    id: string,
    type: string,
    token?: string,
    hash?: string,
  ) {
    await client.query(
      'INSERT INTO gasless_user_action_attempt_events(request_id,event_type,lease_token,transaction_hash) VALUES($1,$2,$3,$4)',
      [id, type, token ?? null, hash ?? null],
    );
  }
  return {
    async accept(input, witness) {
      return transaction(async (client) => {
        const value = requestIdentity(input);
        await lockUserActionNonce(client, value);
        const replay = await client.query<UserActionRequest & { bindingFingerprint: string }>(
          `SELECT ${projection},binding_fingerprint AS "bindingFingerprint" FROM gasless_user_action_requests WHERE owner_service_id=$1 AND source_operation_id=$2 FOR UPDATE`,
          [value.owner, value.operation],
        );
        if (replay.rows[0]) {
          if (
            replay.rows[0].requestFingerprint !== value.fingerprint ||
            replay.rows[0].bindingFingerprint !== witness.bindingFingerprint
          )
            deny('User-action operation conflicts with original accepted request');
          return replay.rows[0];
        }
        await lockedWitness(client, input, witness);
        const result = await client.query<UserActionRequest>(
          `INSERT INTO gasless_user_action_requests(request_id,owner_service_id,source_operation_id,package_id,handoff_id,chain_id,escrow_address,user_address,authorization_nonce,action,request_fingerprint,binding_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING ${projection}`,
          [
            randomUUID(),
            value.owner,
            value.operation,
            value.packageId,
            value.handoffId,
            value.chainId,
            value.escrow,
            value.user,
            value.nonce,
            value.action,
            value.fingerprint,
            witness.bindingFingerprint,
          ],
        );
        if (result.rows[0]) {
          const requestId = result.rows[0].requestId;
          const inventory = await nonceInventory(client, input);
          if (inventory.current) {
            const retirement = witness.ownership.retirements.find(
              (e) => e.scope.requestId === inventory.current,
            );
            if (!retirement) deny('Independent nonce retirement is required');
            await client.query(
              "INSERT INTO gasless_user_action_retirement_events(predecessor_request_id,successor_request_id,event_type,evidence) VALUES($1,$2,'retired',$3)",
              [inventory.current, requestId, retirement],
            );
          }
          await client.query(
            `INSERT INTO gasless_user_action_nonce_owners(chain_id,escrow_address,user_address,authorization_nonce,request_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(chain_id,escrow_address,user_address,authorization_nonce) DO UPDATE SET request_id=EXCLUDED.request_id`,
            [value.chainId, value.escrow, value.user, value.nonce, requestId],
          );
          await event(client, requestId, 'accepted');
          return result.rows[0];
        }
        const existing = await client.query<UserActionRequest & { bindingFingerprint: string }>(
          `SELECT ${projection},binding_fingerprint AS "bindingFingerprint" FROM gasless_user_action_requests WHERE owner_service_id=$1 AND source_operation_id=$2 FOR UPDATE`,
          [value.owner, value.operation],
        );
        const row = existing.rows[0];
        if (
          !row ||
          row.requestFingerprint !== value.fingerprint ||
          row.bindingFingerprint !== witness.bindingFingerprint
        )
          deny('User-action operation conflicts with original accepted request');
        return row;
      });
    },
    async claim(request) {
      return transaction(async (client) => {
        await lockUserActionRequestNonce(client, request.requestId);
        const token = randomUUID();
        const result = await client.query(
          `UPDATE gasless_user_action_requests SET lease_token=$2,lease_expires_at=NOW()+($3*INTERVAL '1 second') WHERE request_id=$1 AND request_fingerprint=$4 AND execution_status='accepted' AND (lease_token IS NULL OR lease_expires_at<=NOW()) RETURNING request_id`,
          [request.requestId, token, leaseSeconds, request.requestFingerprint],
        );
        if (result.rowCount !== 1) deny();
        await event(client, request.requestId, 'claimed', token);
        return { requestId: request.requestId, token };
      });
    },
    async beginSigning(input, witness, claim) {
      await transaction(async (client) => {
        await lockedWitness(client, input, witness);
        if ((await nonceInventory(client, input)).current !== claim.requestId)
          deny('Original current nonce ownership is required');
        const result = await client.query(
          `UPDATE gasless_user_action_requests SET execution_status='signing',signing_started_at=NOW(),lease_token=NULL,lease_expires_at=NULL WHERE request_id=$1 AND lease_token=$2 AND execution_status='accepted' AND lease_expires_at>NOW() AND request_fingerprint=$3 AND binding_fingerprint=$4 RETURNING request_id`,
          [
            claim.requestId,
            claim.token,
            requestIdentity(input).fingerprint,
            witness.bindingFingerprint,
          ],
        );
        if (result.rowCount !== 1) deny('User-action signing fence expired or changed');
        await event(client, claim.requestId, 'signing', claim.token);
      });
    },
    async recordSigned(claim, identity) {
      validateSignedIdentity(identity);
      await transaction(async (client) => {
        await lockUserActionRequestNonce(client, claim.requestId);
        const current = await client.query(
          `SELECT r.owner_service_id,r.handoff_id,r.action,r.chain_id,r.escrow_address FROM gasless_user_action_requests r JOIN gasless_user_action_attempt_events e ON e.request_id=r.request_id WHERE r.request_id=$1 AND e.lease_token=$2 AND e.event_type='signing' FOR UPDATE OF r`,
          [claim.requestId, claim.token],
        );
        const row = current.rows[0];
        if (
          !row ||
          identity.applicationRequestId !== claim.requestId ||
          identity.resourceType !== 'settlement_handoff' ||
          identity.resourceId !== row.handoff_id ||
          identity.operation !== row.action ||
          identity.sourceApiKeyId !== row.owner_service_id ||
          identity.chainId !== Number(row.chain_id) ||
          identity.destinationAddress.toLowerCase() !== row.escrow_address ||
          identity.valueWei !== '0'
        )
          deny('Signed identity provenance changed');
        const existing = await client.query(
          `SELECT event_id FROM gasless_user_action_attempt_events WHERE request_id=$1 AND event_type='signed'`,
          [claim.requestId],
        );
        if (existing.rowCount) deny('Signed identity is already retained');
        await client.query(
          `INSERT INTO gasless_user_action_attempt_events(request_id,event_type,lease_token,transaction_hash,transaction_identity) VALUES($1,'signed',$2,$3,$4)`,
          [claim.requestId, claim.token, identity.transactionHash, identity],
        );
      });
    },
    async recordHash(claim, type, hash) {
      await transaction(async (client) => {
        await lockUserActionRequestNonce(client, claim.requestId);
        const result = await client.query(
          `SELECT request_id FROM gasless_user_action_attempt_events WHERE request_id=$1 AND lease_token=$2 AND event_type='signing'`,
          [claim.requestId, claim.token],
        );
        if (result.rowCount !== 1) deny('User-action signing owner is required');
        await event(client, claim.requestId, type, claim.token, hash.toLowerCase());
      });
    },
    async matches(input) {
      const value = requestIdentity(input);
      const result = await pool.query(
        `SELECT request_id FROM gasless_user_action_requests WHERE owner_service_id=$1 AND source_operation_id=$2 AND request_fingerprint=$3`,
        [value.owner, value.operation, value.fingerprint],
      );
      return result.rowCount === 1;
    },
    async inspect(owner, operation) {
      const request = await pool.query<UserActionRequest>(
        `SELECT ${projection} FROM gasless_user_action_requests WHERE owner_service_id=$1 AND source_operation_id=$2`,
        [owner, operation],
      );
      const row = request.rows[0];
      if (!row) return null;
      const events = await pool.query(
        `SELECT event_type AS "eventType",transaction_hash AS "transactionHash" FROM gasless_user_action_attempt_events WHERE request_id=$1 ORDER BY event_id LIMIT 101`,
        [row.requestId],
      );
      const outcomes = await pool.query(
        `SELECT transaction_hash AS "transactionHash",observed_transaction_hash AS "observedTransactionHash",outcome_status AS "outcomeStatus" FROM gasless_transaction_outcomes WHERE application_request_id=$1 AND source_api_key_id=$2 ORDER BY created_at,transaction_hash LIMIT 11`,
        [row.requestId, owner],
      );
      if (events.rows.length > 100 || outcomes.rows.length > 10)
        deny('User-action evidence requires governed inspection');
      return {
        requestId: row.requestId,
        status: row.status,
        attempts: events.rows,
        outcomes: outcomes.rows,
      };
    },
  };
}
