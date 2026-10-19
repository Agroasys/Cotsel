/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool } from 'pg';
import type {
  GaslessTransactionIdentity,
  GaslessTransactionOutcomeRecorder,
} from '../gaslessTransactionOutcomeStore';
import { IDENTITY_FIELDS, validateSignedIdentity } from './signedIdentity';
import { deny, fingerprint } from './validation';
/** Existing observer pre-cycle repair. No signer, submission port or candidate substitution. */
export async function recoverUserActionSignedIdentities(
  pool: Pool,
  recorder: Pick<GaslessTransactionOutcomeRecorder, 'recordPrepared'>,
  limit: number,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    deny('Bounded identity recovery limit required');
  const candidates = await pool.query<{ identity: GaslessTransactionIdentity }>(
    `SELECT e.transaction_identity AS identity FROM gasless_user_action_attempt_events e
 JOIN gasless_user_action_requests r ON r.request_id=e.request_id
 LEFT JOIN gasless_transaction_outcomes o ON o.transaction_hash=e.transaction_hash
 WHERE e.event_type='signed' AND r.execution_status='signing' AND o.transaction_hash IS NULL
 AND e.transaction_identity->>'transactionHash'=e.transaction_hash
 AND e.transaction_identity->>'applicationRequestId'=r.request_id::text
 AND e.transaction_identity->>'resourceType'='settlement_handoff'
 AND e.transaction_identity->>'resourceId'=r.handoff_id
 AND e.transaction_identity->>'operation'=r.action
 AND e.transaction_identity->>'sourceApiKeyId'=r.owner_service_id
 ORDER BY e.event_id LIMIT $1`,
    [limit],
  );
  for (const { identity } of candidates.rows) {
    validateSignedIdentity(identity);
    try {
      await recorder.recordPrepared(identity);
    } catch (error) {
      // A concurrent worker may have persisted it; compare EVERY immutable signed field.
      const result = await pool.query(
        `SELECT transaction_hash AS "transactionHash",application_request_id AS "applicationRequestId",resource_type AS "resourceType",resource_id AS "resourceId",operation,chain_id::int AS "chainId",signer_address AS "signerAddress",transaction_nonce::int AS nonce,transaction_type AS "transactionType",destination_address AS "destinationAddress",value_wei::text AS "valueWei",gas_limit::text AS "gasLimit",max_fee_per_gas_wei::text AS "maxFeePerGasWei",max_priority_fee_per_gas_wei::text AS "maxPriorityFeePerGasWei",gas_price_wei::text AS "gasPriceWei",calldata_hash AS "calldataHash",intent_hash AS "intentHash",source_api_key_id AS "sourceApiKeyId" FROM gasless_transaction_outcomes WHERE transaction_hash=$1`,
        [identity.transactionHash],
      );
      if (
        result.rowCount !== 1 ||
        fingerprint(
          Object.fromEntries(IDENTITY_FIELDS.map((key) => [key, result.rows[0][key]])),
        ) !== fingerprint(identity)
      )
        throw error;
    }
  }
}
