import { Logger } from '../utils/logger';

const counters = {
  authFailuresTotal: 0,
  replayRejectsTotal: 0,
  documentStoreRetriesTotal: 0,
  documentStoreFailuresTotal: 0,
  documentIntegrityFailuresTotal: 0,
};

export function incrementAuthFailure(reason: string): void {
  counters.authFailuresTotal += 1;
  Logger.warn('Metric increment', {
    metric: 'auth_failures_total',
    reason,
    value: counters.authFailuresTotal,
  });
}

export function incrementReplayReject(): void {
  counters.replayRejectsTotal += 1;
  Logger.warn('Metric increment', {
    metric: 'replay_rejects_total',
    value: counters.replayRejectsTotal,
  });
}

export function incrementDocumentStoreRetry(operation: string): void {
  counters.documentStoreRetriesTotal += 1;
  Logger.warn('Metric increment', {
    metric: 'document_store_retries_total',
    operation,
    value: counters.documentStoreRetriesTotal,
  });
}

export function incrementDocumentStoreFailure(operation: string, errorCode: string): void {
  counters.documentStoreFailuresTotal += 1;
  Logger.error('Metric increment', {
    metric: 'document_store_failures_total',
    operation,
    errorCode,
    value: counters.documentStoreFailuresTotal,
  });
}

export function incrementDocumentIntegrityFailure(): void {
  counters.documentIntegrityFailuresTotal += 1;
  Logger.error('Metric increment', {
    metric: 'document_integrity_failures_total',
    value: counters.documentIntegrityFailuresTotal,
  });
}
