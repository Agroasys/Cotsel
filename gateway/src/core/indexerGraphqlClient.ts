/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { executeHttpRequestWithPolicy } from './serviceOrchestrator';
import type { DownstreamServiceContract } from './serviceRegistry';

const STALE_THRESHOLD_MS = 5 * 60 * 1_000;

const indexerHealthQuery = `
  query IndexerHealth {
    overviewSnapshotById(id: "singleton") {
      lastIndexedAt
      lastProcessedBlock
    }
  }
`;

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface IndexerHealthSnapshot {
  lastIndexedAt: string;
  lastProcessedBlock: string;
}

interface IndexerHealthData {
  overviewSnapshotById?: IndexerHealthSnapshot | null;
}

function createIndexerContract(graphqlUrl: string, requestTimeoutMs: number): DownstreamServiceContract {
  return {
    key: 'indexer',
    name: 'Indexer GraphQL',
    source: 'indexer_graphql',
    baseUrl: graphqlUrl,
    auth: { mode: 'none' },
    readTimeoutMs: requestTimeoutMs,
    mutationTimeoutMs: requestTimeoutMs,
    readRetryBudget: 1,
    mutationRetryBudget: 0,
  };
}

export class IndexerGraphqlClient {
  private readonly contract: DownstreamServiceContract;

  constructor(
    graphqlUrl: string,
    requestTimeoutMs: number,
  ) {
    this.contract = createIndexerContract(graphqlUrl, requestTimeoutMs);
  }

  async query<T>(operationName: string, query: string, variables?: Record<string, unknown>): Promise<GraphQlResponse<T>> {
    const response = await executeHttpRequestWithPolicy({
      service: this.contract,
      method: 'POST',
      path: '',
      body: {
        operationName,
        query,
        ...(variables ? { variables } : {}),
      },
      readOnly: true,
      authenticated: false,
      operation: operationName,
    });

    if (!response.ok) {
      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer request failed with HTTP ${response.status}`, {
        operationName,
        status: response.status,
      });
    }

    const payload = await response.json() as GraphQlResponse<T>;
    if (payload.errors?.length) {
      throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned GraphQL errors', {
        operationName,
        errors: payload.errors.map((error) => error.message),
      });
    }

    return payload;
  }

  async checkHealth(staleThresholdMs = STALE_THRESHOLD_MS): Promise<void> {
    const payload = await this.query<IndexerHealthData>('IndexerHealth', indexerHealthQuery);
    const snapshot = payload.data?.overviewSnapshotById;

    if (!snapshot) {
      throw new Error('Indexer has not yet produced an overview snapshot');
    }

    const parsedAt = Date.parse(snapshot.lastIndexedAt);
    if (!snapshot.lastIndexedAt || Number.isNaN(parsedAt)) {
      throw new Error('Indexer snapshot has an invalid or missing lastIndexedAt timestamp');
    }

    const stalenessMs = Date.now() - parsedAt;
    if (stalenessMs > staleThresholdMs) {
      const minutes = Math.round(stalenessMs / 60_000);
      throw new Error(
        `Indexer snapshot is stale: last processed block ${snapshot.lastProcessedBlock} indexed ${minutes} minute(s) ago`,
      );
    }
  }
}
