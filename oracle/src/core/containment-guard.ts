import { Pool } from 'pg';
import { createServicePool } from '@agroasys/shared-db';
import { Logger } from '../utils/logger';
import { TradeContainedError, getErrorMessage } from '../utils/errors';
import type { OracleConfig } from '../types';

/**
 * The reconcile tables sit behind row-level security keyed on the service name.
 * The dedicated reader presents reconciliation's identity without receiving
 * reconciliation's write capability.
 */
const RECONCILIATION_SERVICE_NAME = 'reconciliation';

export interface ContainmentGuard {
  /** Throws `TradeContainedError` unless this trade is clear to progress. */
  assertMayProgress(tradeId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * A guard for deployments with no reconciliation database configured.
 *
 * It permits everything, and says so loudly at startup: a containment control
 * nobody is enforcing must not look like one that is.
 */
const UNGUARDED: ContainmentGuard = {
  async assertMayProgress(): Promise<void> {},
  async close(): Promise<void> {},
};

/**
 * Refuse to progress a trade that reconciliation has contained.
 *
 * PRES-11 contains a trade the moment a qualified discrepancy is found — money,
 * parties or agreement identity disagreeing between the chain and the
 * projection. The escrow's own scoped `pauseTrade` is the enforcement of last
 * resort, but it is an admin action that has to be applied by a human, and in
 * the window before it lands the oracle would otherwise happily submit the next
 * milestone for a trade whose settlement facts are in dispute. This closes that
 * window: the containment row itself blocks progression, from the moment
 * reconciliation commits it.
 *
 * Deliberately fail-closed. A guard that cannot read its table does not know
 * whether the trade is contained, and "not known to be contained" is not the
 * same as "clear to settle" — so an unreachable reconciliation database stops
 * progressions rather than waving them through. The read is a single indexed
 * lookup on the settlement path, and the oracle's retry classification treats
 * the refusal as retryable, so a brief outage delays a milestone instead of
 * failing it terminally.
 */
class ReconciliationContainmentGuard implements ContainmentGuard {
  constructor(private readonly pool: Pool) {}

  async assertMayProgress(tradeId: string): Promise<void> {
    let row: { incident_reference: string; state: string } | undefined;

    try {
      const result = await this.pool.query<{ incident_reference: string; state: string }>(
        `SELECT incident_reference, state
         FROM reconcile_trade_containments
         WHERE trade_id = $1 AND state <> 'RELEASED'`,
        [tradeId],
      );
      row = result.rows[0];
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      Logger.error('Containment guard could not be read; refusing to progress the trade', {
        tradeId,
        error: message,
      });
      throw new TradeContainedError(
        tradeId,
        null,
        `Cannot confirm trade ${tradeId} is clear of a reconciliation containment: ${message}`,
      );
    }

    if (!row) {
      return;
    }

    Logger.error('Refusing to progress a contained trade', {
      tradeId,
      incidentReference: row.incident_reference,
      containmentState: row.state,
    });

    throw new TradeContainedError(
      tradeId,
      row.incident_reference,
      `Trade ${tradeId} is under reconciliation containment ${row.incident_reference} ` +
        `(${row.state}) and must not progress until it is released`,
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function buildContainmentGuard(config: OracleConfig): ContainmentGuard {
  if (
    !config.reconciliationDbName ||
    !config.reconciliationDbUser ||
    !config.reconciliationDbPassword
  ) {
    Logger.warn(
      'No reconciliation database configured: trade progressions are not gated on PRES-11 containment',
      { configKey: 'RECONCILIATION_DB_NAME' },
    );
    return UNGUARDED;
  }

  return new ReconciliationContainmentGuard(
    createServicePool({
      serviceName: RECONCILIATION_SERVICE_NAME,
      connectionRole: 'runtime',
      runtimeDbUser: config.reconciliationDbUser,
      host: config.reconciliationDbHost ?? config.dbHost,
      port: config.reconciliationDbPort ?? config.dbPort,
      database: config.reconciliationDbName,
      user: config.reconciliationDbUser,
      password: config.reconciliationDbPassword,
      sslMode: config.reconciliationDbSslMode ?? config.dbSslMode,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    }),
  );
}

/**
 * The default guard, built from configuration the first time a trade is
 * actually checked.
 *
 * Deferred rather than resolved at import: `TriggerManager` is constructed in
 * unit tests that have no oracle environment, and requiring one just to load
 * the module would make the guard harder to adopt than to skip. In the running
 * service `config` is already loaded by the entrypoint, so the first check
 * reads it straight from the module cache.
 */
export function createContainmentGuard(): ContainmentGuard {
  let resolved: ContainmentGuard | null = null;

  const resolve = async (): Promise<ContainmentGuard> => {
    if (!resolved) {
      const { config } = await import('../config');
      resolved = buildContainmentGuard(config);
    }
    return resolved;
  };

  return {
    async assertMayProgress(tradeId: string): Promise<void> {
      await (await resolve()).assertMayProgress(tradeId);
    },
    async close(): Promise<void> {
      await resolved?.close();
    },
  };
}
