import type { ManagedSignerValidationAuditRecord } from '@agroasys/sdk';
import type { Pool } from 'pg';

export interface ManagedSignerAuditStore {
  append(record: ManagedSignerValidationAuditRecord): Promise<void>;
}

export function createPostgresManagedSignerAuditStore(pool: Pool): ManagedSignerAuditStore {
  return {
    async append(record) {
      await pool.query(
        `INSERT INTO managed_signer_validation_audit (
           request_id,
           intent_hash,
           signed_transaction_hash,
           signer_address,
           transaction_nonce,
           transaction_type,
           outcome,
           failure_reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          record.requestId,
          record.intentHash,
          record.signedTransactionHash ?? null,
          record.signerAddress,
          record.nonce,
          record.transactionType,
          record.outcome,
          record.failureReason ?? null,
        ],
      );
    },
  };
}
