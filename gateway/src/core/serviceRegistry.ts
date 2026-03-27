/**
 * SPDX-License-Identifier: Apache-2.0
 */

export type DownstreamServiceKey =
  | 'indexer'
  | 'oracle'
  | 'treasury'
  | 'reconciliation'
  | 'ricardian'
  | 'notifications';

export type DownstreamAuthMode = 'none' | 'shared_hmac' | 'oracle_legacy_hmac';
export type DownstreamHeaderStyle = 'agroasys' | 'legacy';

export interface DownstreamServiceAuthContract {
  mode: DownstreamAuthMode;
  headerStyle?: DownstreamHeaderStyle;
  apiKey?: string;
  apiSecret?: string;
}

export interface DownstreamServiceContract {
  key: DownstreamServiceKey;
  name: string;
  source: string;
  baseUrl?: string;
  healthPath?: string;
  auth: DownstreamServiceAuthContract;
  readTimeoutMs: number;
  mutationTimeoutMs: number;
  readRetryBudget: number;
  mutationRetryBudget: number;
}

export interface DownstreamServiceRegistry {
  get(service: DownstreamServiceKey): DownstreamServiceContract;
  list(): DownstreamServiceContract[];
}

export function createDownstreamServiceRegistry(
  contracts: DownstreamServiceContract[],
): DownstreamServiceRegistry {
  const byKey = new Map<DownstreamServiceKey, DownstreamServiceContract>(
    contracts.map((contract) => [contract.key, contract]),
  );

  return {
    get(service) {
      const contract = byKey.get(service);
      if (!contract) {
        throw new Error(`Downstream service contract is not registered: ${service}`);
      }

      return contract;
    },
    list() {
      return [...byKey.values()];
    },
  };
}
