import { pool } from './connection';
import type { Trigger } from '../types/trigger';
import type { OracleDispatchFinality } from '../blockchain/dispatch-finality';

export async function getUnresolvedSignerDispatch(signerScope: string): Promise<Trigger | null> {
  const result = await pool.query(
    `SELECT * FROM oracle_triggers WHERE dispatch_started_at IS NOT NULL
     AND dispatch_finality_evidence IS NULL AND (dispatch_signer_scope=$1 OR dispatch_signer_scope IS NULL)
     ORDER BY dispatch_started_at,id LIMIT 1`,
    [signerScope],
  );
  return result.rows[0] ?? null;
}
/** Reserve the signer before any send. A different action cannot bypass unknown nonce exposure. */
export async function claimTriggerDispatch(
  idempotencyKey: string,
  signerScope: string,
): Promise<boolean> {
  if (!/^[1-9][0-9]*:0x[0-9a-f]{40}$/.test(signerScope))
    throw new Error('Invalid Oracle signer scope');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(91309,hashtext($1))', [signerScope]);
    const result = await client.query(
      `UPDATE oracle_triggers SET dispatch_started_at=NOW(),dispatch_signer_scope=$2,status='EXECUTING',updated_at=NOW()
       WHERE idempotency_key=$1 AND dispatch_started_at IS NULL AND funded_binding IS NOT NULL
       AND funded_binding->>'chainId'=split_part($2,':',1)
       AND status IN ('PENDING','EXECUTING','FAILED','PENDING_APPROVAL')
       AND NOT EXISTS (SELECT 1 FROM oracle_triggers other WHERE other.dispatch_started_at IS NOT NULL
         AND other.dispatch_finality_evidence IS NULL AND (other.dispatch_signer_scope=$2 OR other.dispatch_signer_scope IS NULL))
       RETURNING id`,
      [idempotencyKey, signerScope],
    );
    await client.query('COMMIT');
    return result.rowCount === 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function resolveSignerDispatch(
  idempotencyKey: string,
  evidence: OracleDispatchFinality,
): Promise<void> {
  const verifiedAt = Date.parse(evidence.verifiedAt);
  if (
    evidence.policy !== 'oracle_dispatch_nonce_finality_v1' ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt > Date.now() ||
    Date.now() - verifiedAt > 10000 ||
    !Number.isSafeInteger(evidence.blockNumber) ||
    evidence.blockNumber < 0 ||
    !/^0x[0-9a-f]{64}$/.test(evidence.blockHash) ||
    !/^0x[0-9a-f]{64}$/.test(evidence.transactionHash) ||
    (evidence.receiptStatus !== 0 && evidence.receiptStatus !== 1) ||
    evidence.witnessIds.length !== 2 ||
    evidence.witnessIds.some((id) => !/^[0-9a-f]{64}$/.test(id)) ||
    evidence.witnessIds[0] === evidence.witnessIds[1]
  )
    throw new Error('Fresh independent original dispatch evidence is required');
  const result = await pool.query(
    `UPDATE oracle_triggers SET dispatch_finality_evidence=$3::jsonb,updated_at=NOW()
     WHERE idempotency_key=$1 AND dispatch_signer_scope=$2 AND tx_hash=$4
       AND dispatch_started_at IS NOT NULL AND dispatch_finality_evidence IS NULL
     RETURNING id`,
    [idempotencyKey, evidence.signerScope, JSON.stringify(evidence), evidence.transactionHash],
  );
  if (result.rowCount === 1) return;
  const existing = await pool.query(
    'SELECT dispatch_finality_evidence FROM oracle_triggers WHERE idempotency_key=$1 AND dispatch_signer_scope=$2 AND tx_hash=$3',
    [idempotencyKey, evidence.signerScope, evidence.transactionHash],
  );
  const retained = existing.rows[0]?.dispatch_finality_evidence as
    OracleDispatchFinality | undefined;
  if (
    !retained ||
    retained.policy !== evidence.policy ||
    retained.signerScope !== evidence.signerScope ||
    retained.transactionHash !== evidence.transactionHash ||
    retained.blockNumber !== evidence.blockNumber ||
    retained.blockHash !== evidence.blockHash ||
    retained.receiptStatus !== evidence.receiptStatus
  )
    throw new Error('Original Oracle dispatch evidence changed');
}
