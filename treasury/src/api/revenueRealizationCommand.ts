import { requireInteger, optionalNullableString, optionalRecord } from '@agroasys/shared-http';
import { getLedgerEntryAccountingFacts, createRevenueRealization } from '../database/queries';
import type { CreateRevenueRealizationBody } from './requestBodies';
import type { SweepExecutionMatcherService } from '../core/sweepExecutionMatcher';
import type { ReconciliationGateService } from '../core/reconciliationGate';
import { resolveRealizationBinding } from './realizationBinding';
/** Build the retained command from the entry's actual batch, never a caller-selected sweep. */
export async function realizeEntryWithFinalizedSweep(
  entryId: number,
  body: CreateRevenueRealizationBody,
  actor: string,
  matcher: Pick<SweepExecutionMatcherService, 'revalidateMatchedBatch'>,
  reconciliation: ReconciliationGateService,
) {
  const facts = await getLedgerEntryAccountingFacts(entryId);
  if (!facts?.sweep_batch_id) throw new Error('Original sweep batch is required for realization');
  const batchId =
    body.sweepBatchId === undefined || body.sweepBatchId === null
      ? facts.sweep_batch_id
      : requireInteger(body.sweepBatchId, 'sweepBatchId', { min: 1 });
  if (batchId !== facts.sweep_batch_id)
    throw new Error('Revenue realization sweep batch does not match the ledger entry batch');
  const [finalizedSweepEvidence, reconciliationBinding] = await Promise.all([
    matcher.revalidateMatchedBatch(batchId),
    resolveRealizationBinding(reconciliation, entryId),
  ]);
  return createRevenueRealization({
    ledgerEntryId: entryId,
    accountingPeriodId: requireInteger(body.accountingPeriodId, 'accountingPeriodId', { min: 1 }),
    sweepBatchId: batchId,
    partnerHandoffId:
      body.partnerHandoffId === undefined || body.partnerHandoffId === null
        ? null
        : requireInteger(body.partnerHandoffId, 'partnerHandoffId', { min: 1 }),
    actor,
    note: optionalNullableString(body.note, 'note'),
    metadata: optionalRecord(body.metadata, 'metadata'),
    finalizedSweepEvidence,
    reconciliationBinding,
  });
}
