import { lockUserActionNonce } from './nonceLock';
/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool, PoolClient } from 'pg';
import type { GaslessUserActionExecutionInput } from '../gaslessExecutionTypes';
import { deny, fingerprint, requestIdentity } from './validation';
export interface UserActionRetirementScope {
  requestId: string;
  ownerServiceId: string;
  sourceOperationId: string;
  packageId: string;
  requestFingerprint: string;
  bindingFingerprint: string;
  originalFundingFingerprint: string;
  chainId: number;
  escrowAddress: string;
  userAddress: string;
  nonce: string;
  deadline: string;
  inventoryFingerprint: string;
  priorRetirements: Array<Pick<UserActionRetirementEvidence, 'anchor' | 'financialOutcome'>>;
}
export interface UserActionRetirementEvidence {
  scope: UserActionRetirementScope;
  anchor: { chainId: number; blockNumber: string; blockHash: string; timestamp: string };
  authorizationNonce: string;
  financialOutcome: {
    authority: 'settlement';
    evidenceId: string;
    fingerprint: string;
    originalFundingFingerprint: string;
    kind: 'oracle_resolved_without_user_execution' | 'independent_resolved_non_execution';
    transactionHash: string | null;
    blockNumber: string;
    blockHash: string;
  };
}
/** Owning-domain adapter must independently verify canonical anchors AND financial truth.
 * Missing/unavailable authenticated owning evidence cannot become approval. */
export type VerifyUserActionRetirement = (
  scope: UserActionRetirementScope,
) => Promise<
  | { status: 'verified'; evidence: UserActionRetirementEvidence }
  | { status: 'unavailable' | 'contradicted' }
>;
export interface NonceOwnershipWitness {
  snapshot: string;
  retirements: UserActionRetirementEvidence[];
}
type Query = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
export async function nonceInventory(db: Query, input: GaslessUserActionExecutionInput) {
  const id = requestIdentity(input);
  const result = await db.query(
    `SELECT r.request_id AS "requestId",r.owner_service_id AS "ownerServiceId",r.source_operation_id AS "sourceOperationId",r.package_id AS "packageId",r.handoff_id AS "handoffId",r.request_fingerprint AS "requestFingerprint",r.binding_fingerprint AS "bindingFingerprint",r.chain_id::text AS "chainId",r.escrow_address AS "escrowAddress",r.user_address AS "userAddress",r.authorization_nonce::text AS nonce,h.execution_binding AS binding,r.execution_status AS status,
 (SELECT COALESCE(jsonb_agg(e ORDER BY e.event_id::bigint),'[]'::jsonb) FROM (SELECT event_id::text AS event_id,event_type,transaction_hash,transaction_identity FROM gasless_user_action_attempt_events WHERE request_id=r.request_id ORDER BY event_id LIMIT 101) e) AS attempts,
 (SELECT COALESCE(jsonb_agg(o ORDER BY o.transaction_hash),'[]'::jsonb) FROM (SELECT transaction_hash,observed_transaction_hash,outcome_status,block_number::text AS block_number,block_hash,finality_evidence FROM gasless_transaction_outcomes WHERE application_request_id=r.request_id::text ORDER BY transaction_hash LIMIT 11) o) AS outcomes
 FROM gasless_user_action_requests r JOIN settlement_handoffs h ON h.handoff_id=r.handoff_id
 WHERE r.chain_id=$1 AND r.escrow_address=$2 AND r.user_address=$3 AND r.authorization_nonce=$4 ORDER BY r.request_id LIMIT 101`,
    [id.chainId, id.escrow, id.user, id.nonce],
  );
  const owner = await db.query(
    `SELECT request_id AS "requestId" FROM gasless_user_action_nonce_owners WHERE chain_id=$1 AND escrow_address=$2 AND user_address=$3 AND authorization_nonce=$4`,
    [id.chainId, id.escrow, id.user, id.nonce],
  );
  const events = await db.query(
    `SELECT event_id,event_type,predecessor_request_id,successor_request_id,evidence FROM gasless_user_action_retirement_events WHERE predecessor_request_id=ANY($1::uuid[]) ORDER BY event_id LIMIT 101`,
    [result.rows.map((row) => row.requestId)],
  );
  if (
    result.rows.length > 100 ||
    events.rows.length > 100 ||
    result.rows.some((row) => row.attempts.length > 100 || row.outcomes.length > 10)
  )
    deny('Nonce history exceeds bounded automatic inspection');
  return { requests: result.rows, current: owner.rows[0]?.requestId ?? null, history: events.rows };
}
export async function verifyNonceOwnership(
  pool: Pool,
  input: GaslessUserActionExecutionInput,
  verify: VerifyUserActionRetirement,
  now: () => number = Date.now,
): Promise<NonceOwnershipWitness> {
  const checkedAt = now();
  const inventory = await nonceInventory(pool, input);
  if (inventory.history.some((row) => row.event_type === 'drift'))
    deny('Predecessor retirement has canonical drift');
  const current = inventory.requests.find((row) => row.requestId === inventory.current);
  const id = requestIdentity(input);
  const predecessors = new Set(
    inventory.history
      .filter((row) => row.event_type === 'retired')
      .map((row) => row.predecessor_request_id),
  );
  if (
    current &&
    (current.ownerServiceId !== id.owner || current.sourceOperationId !== id.operation)
  )
    predecessors.add(current.requestId);
  if (!inventory.current && inventory.requests.length)
    deny('Nonce ownership inventory is inconsistent');
  const retirements: UserActionRetirementEvidence[] = [];
  for (const predecessor of predecessors) {
    if (now() < checkedAt || now() - checkedAt > 10_000) deny('Retirement preflight expired');
    const row = inventory.requests.find((value) => value.requestId === predecessor);
    if (!row) deny('Predecessor identity is missing');
    const scope: UserActionRetirementScope = {
      requestId: row.requestId,
      ownerServiceId: row.ownerServiceId,
      sourceOperationId: row.sourceOperationId,
      packageId: row.packageId,
      requestFingerprint: row.requestFingerprint,
      bindingFingerprint: row.bindingFingerprint,
      originalFundingFingerprint: row.binding.originalFundingFingerprint,
      chainId: Number(row.chainId),
      escrowAddress: row.escrowAddress,
      userAddress: row.userAddress,
      nonce: row.nonce,
      deadline: row.binding.deadline,
      inventoryFingerprint: fingerprint(row),
      priorRetirements: inventory.history
        .filter(
          (event) =>
            event.event_type === 'retired' && event.predecessor_request_id === row.requestId,
        )
        .map((event) => ({
          anchor: event.evidence.anchor,
          financialOutcome: event.evidence.financialOutcome,
        })),
    };

    const expectedScope = fingerprint(scope);
    const proof = await verify(Object.freeze(scope));
    if (fingerprint(scope) !== expectedScope) deny('Predecessor retirement scope changed');
    if (now() < checkedAt || now() - checkedAt > 10_000) deny('Retirement preflight expired');
    if (proof.status !== 'verified') {
      if (proof.status === 'contradicted') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await lockUserActionNonce(client, {
            chainId: scope.chainId,
            escrow: scope.escrowAddress,
            user: scope.userAddress,
            nonce: scope.nonce,
          });
          await client.query(
            "INSERT INTO gasless_user_action_retirement_events(predecessor_request_id,event_type,evidence) VALUES($1,'drift',$2)",
            [scope.requestId, { scope }],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      deny('Independent predecessor retirement evidence is required');
    }
    const e = proof.evidence;
    validateUserActionRetirementEvidence(e, scope);
    retirements.push(e);
  }
  return { snapshot: fingerprint(inventory), retirements };
}

/** Shared untrusted transport boundary; performs no network or writes. */
export function validateUserActionRetirementEvidence(
  e: UserActionRetirementEvidence,
  scope: UserActionRetirementScope,
): void {
  const exact = (value: unknown, keys: string[]) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
  if (
    !exact(e, ['scope', 'anchor', 'authorizationNonce', 'financialOutcome']) ||
    !exact(e.anchor, ['chainId', 'blockNumber', 'blockHash', 'timestamp']) ||
    !exact(e.financialOutcome, [
      'authority',
      'evidenceId',
      'fingerprint',
      'originalFundingFingerprint',
      'kind',
      'transactionHash',
      'blockNumber',
      'blockHash',
    ])
  )
    deny('Predecessor retirement evidence is invalid');
  const decimal = (value: unknown): value is string =>
    typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
  if (
    fingerprint(e.scope) !== fingerprint(scope) ||
    e.anchor.chainId !== scope.chainId ||
    !decimal(e.anchor.timestamp) ||
    BigInt(e.anchor.timestamp) <= BigInt(scope.deadline) ||
    e.authorizationNonce !== scope.nonce ||
    !/^0x[0-9a-f]{64}$/.test(e.anchor.blockHash) ||
    !decimal(e.anchor.blockNumber) ||
    e.financialOutcome.authority !== 'settlement' ||
    !['oracle_resolved_without_user_execution', 'independent_resolved_non_execution'].includes(
      e.financialOutcome.kind,
    ) ||
    e.financialOutcome.originalFundingFingerprint !== scope.originalFundingFingerprint ||
    typeof e.financialOutcome.evidenceId !== 'string' ||
    !/^\S{1,128}$/.test(e.financialOutcome.evidenceId) ||
    !/^0x[0-9a-f]{64}$/.test(e.financialOutcome.fingerprint) ||
    (!(
      e.financialOutcome.kind === 'independent_resolved_non_execution' &&
      e.financialOutcome.transactionHash === null
    ) &&
      !/^0x[0-9a-f]{64}$/.test(e.financialOutcome.transactionHash ?? '')) ||
    !/^0x[0-9a-f]{64}$/.test(e.financialOutcome.blockHash) ||
    !decimal(e.financialOutcome.blockNumber) ||
    BigInt(e.financialOutcome.blockNumber) > BigInt(e.anchor.blockNumber)
  )
    deny('Predecessor retirement evidence is invalid');
}
