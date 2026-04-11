import { Logger } from '../utils/logger';

const counters = {
  oracleExhaustedRetriesTotal: 0,
  oracleRedriveAttemptsTotal: 0,
  oraclePendingApprovalTotal: 0,
  oracleApprovedTotal: 0,
  oracleRejectedTotal: 0,
};

export function incrementOracleExhaustedRetries(actionKey: string): void {
  counters.oracleExhaustedRetriesTotal += 1;
  Logger.warn('Metric increment', {
    metric: 'oracle_exhausted_retries_total',
    actionKey,
    value: counters.oracleExhaustedRetriesTotal,
  });
}

export function incrementOracleRedriveAttempts(actionKey: string): void {
  counters.oracleRedriveAttemptsTotal += 1;
  Logger.info('Metric increment', {
    metric: 'oracle_redrive_attempts_total',
    actionKey,
    value: counters.oracleRedriveAttemptsTotal,
  });
}

export function incrementOraclePendingApproval(actionKey: string): void {
  counters.oraclePendingApprovalTotal += 1;
  Logger.warn('Metric increment', {
    metric: 'oracle_pending_approval_total',
    actionKey,
    value: counters.oraclePendingApprovalTotal,
  });
}

export function incrementOracleApproved(actionKey: string): void {
  counters.oracleApprovedTotal += 1;
  Logger.info('Metric increment', {
    metric: 'oracle_approved_total',
    actionKey,
    value: counters.oracleApprovedTotal,
  });
}

export function incrementOracleRejected(actionKey: string): void {
  counters.oracleRejectedTotal += 1;
  Logger.warn('Metric increment', {
    metric: 'oracle_rejected_total',
    actionKey,
    value: counters.oracleRejectedTotal,
  });
}
