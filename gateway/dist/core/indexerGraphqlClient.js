"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IndexerGraphqlClient = void 0;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const errors_1 = require("../errors");
const serviceOrchestrator_1 = require("./serviceOrchestrator");
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const indexerHealthQuery = `
  query IndexerHealth {
    overviewSnapshotById(id: "singleton") {
      lastIndexedAt
      lastProcessedBlock
    }
  }
`;
function createIndexerContract(graphqlUrl, requestTimeoutMs) {
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
class IndexerGraphqlClient {
    constructor(graphqlUrl, requestTimeoutMs) {
        this.contract = createIndexerContract(graphqlUrl, requestTimeoutMs);
    }
    async query(operationName, query, variables) {
        const response = await (0, serviceOrchestrator_1.executeHttpRequestWithPolicy)({
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
            throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', `Indexer request failed with HTTP ${response.status}`, {
                operationName,
                status: response.status,
            });
        }
        const payload = await response.json();
        if (payload.errors?.length) {
            throw new errors_1.GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Indexer returned GraphQL errors', {
                operationName,
                errors: payload.errors.map((error) => error.message),
            });
        }
        return payload;
    }
    async checkHealth(staleThresholdMs = STALE_THRESHOLD_MS) {
        const payload = await this.query('IndexerHealth', indexerHealthQuery);
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
            const minutes = Math.round(stalenessMs / 60000);
            throw new Error(`Indexer snapshot is stale: last processed block ${snapshot.lastProcessedBlock} indexed ${minutes} minute(s) ago`);
        }
    }
}
exports.IndexerGraphqlClient = IndexerGraphqlClient;
//# sourceMappingURL=indexerGraphqlClient.js.map