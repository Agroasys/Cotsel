import type { GatewayConfig } from '../config/gatewayConfig';
import { createDownstreamServiceRegistry, type DownstreamServiceRegistry } from './serviceRegistry';

/** Server configuration owns downstream routing and authentication; requests cannot select a URL. */
export function createConfiguredDownstreamServiceRegistry(
  config: GatewayConfig,
): DownstreamServiceRegistry {
  const retainedOracleServices = (config.retainedSettlementRails ?? [])
    .filter((rail) => rail.executionOracleBaseUrl)
    .map((rail) => ({
      key: `retained_oracle:${rail.chainId}:${rail.escrowAddress}` as const,
      name: 'Retained settlement Oracle',
      source: 'retained_oracle_http',
      baseUrl: rail.executionOracleBaseUrl,
      healthPath: '/api/oracle/health',
      auth: config.oracleServiceApiSecret
        ? {
            mode: 'oracle_legacy_hmac' as const,
            headerStyle: 'legacy' as const,
            apiKey: config.oracleServiceApiKey,
            apiSecret: config.oracleServiceApiSecret,
          }
        : { mode: 'none' as const },
      readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
      mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
      readRetryBudget: config.downstreamReadRetryBudget ?? 1,
      mutationRetryBudget: 0,
    }));
  return createDownstreamServiceRegistry([
    ...retainedOracleServices,
    {
      key: 'oracle',
      name: 'Oracle',
      source: 'oracle_http',
      baseUrl: config.oracleBaseUrl,
      healthPath: '/api/oracle/health',
      auth: config.oracleServiceApiSecret
        ? {
            mode: 'oracle_legacy_hmac',
            headerStyle: 'legacy',
            apiKey: config.oracleServiceApiKey,
            apiSecret: config.oracleServiceApiSecret,
          }
        : { mode: 'none' },
      readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
      mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
      readRetryBudget: config.downstreamReadRetryBudget ?? 1,
      mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
    {
      key: 'treasury',
      name: 'Treasury',
      source: 'treasury_http',
      baseUrl: config.treasuryBaseUrl,
      healthPath: '/api/treasury/v1/auth-check',
      auth: config.treasuryServiceApiSecret
        ? {
            mode: 'shared_hmac',
            headerStyle: 'agroasys',
            apiKey: config.treasuryServiceApiKey,
            apiSecret: config.treasuryServiceApiSecret,
          }
        : { mode: 'none' },
      readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
      mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
      readRetryBudget: config.downstreamReadRetryBudget ?? 1,
      mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
    {
      key: 'reconciliation',
      name: 'Reconciliation',
      source: 'reconciliation_http',
      baseUrl: config.reconciliationBaseUrl,
      healthPath: '/health',
      auth: { mode: 'none' },
      readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
      mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
      readRetryBudget: config.downstreamReadRetryBudget ?? 1,
      mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
    {
      key: 'ricardian',
      name: 'Ricardian Engine',
      source: 'ricardian_http',
      baseUrl: config.ricardianBaseUrl,
      healthPath: '/api/ricardian/v1/auth-check',
      auth: config.ricardianServiceApiSecret
        ? {
            mode: 'shared_hmac',
            headerStyle: 'agroasys',
            apiKey: config.ricardianServiceApiKey,
            apiSecret: config.ricardianServiceApiSecret,
          }
        : { mode: 'none' },
      readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
      mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
      readRetryBudget: config.downstreamReadRetryBudget ?? 1,
      mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
    {
      key: 'notifications',
      name: 'Notifications',
      source: 'notifications_http',
      baseUrl: config.notificationsBaseUrl,
      auth: { mode: 'none' },
      readTimeoutMs: config.downstreamReadTimeoutMs ?? 5_000,
      mutationTimeoutMs: config.downstreamMutationTimeoutMs ?? 8_000,
      readRetryBudget: config.downstreamReadRetryBudget ?? 1,
      mutationRetryBudget: config.downstreamMutationRetryBudget ?? 0,
    },
  ]);
}
