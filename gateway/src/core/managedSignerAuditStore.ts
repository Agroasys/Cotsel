/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ManagedSignerValidationAuditRecord } from '@agroasys/sdk';
import type { Pool } from 'pg';
import { Logger } from '../logging/logger';
import type { ManagedSignerValidationRecorder } from './managedSignerIntentValidation';

export interface ManagedSignerAuditContext {
  operation: string;
  applicationRequestId: string;
  resourceId: string;
}

export interface ManagedSignerAuditStore {
  append(
    record: ManagedSignerValidationAuditRecord,
    context: ManagedSignerAuditContext,
  ): Promise<void>;
}

export function createPostgresManagedSignerAuditStore(pool: Pool): ManagedSignerAuditStore {
  return {
    async append(record, context) {
      await pool.query(
        `INSERT INTO managed_signer_validation_audit (
           request_id,
           application_request_id,
           resource_id,
           operation,
           intent_hash,
           signed_transaction_hash,
           signer_address,
           transaction_nonce,
           transaction_type,
           outcome,
           failure_reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.requestId,
          context.applicationRequestId,
          context.resourceId,
          context.operation,
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

export function createPostgresManagedSignerValidationRecorder(
  pool: Pool,
): ManagedSignerValidationRecorder {
  const store = createPostgresManagedSignerAuditStore(pool);
  return async (record, context) => {
    await store.append(record, context);
    const metadata = { ...record, ...context };
    if (record.outcome === 'accepted') {
      Logger.info('Managed signer transaction validated before broadcast', metadata);
      return;
    }
    Logger.warn('Managed signer transaction rejected before broadcast', metadata);
  };
}
