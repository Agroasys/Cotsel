"use strict";
/**
 * SPDX-License-Identifier: Apache-2.0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkIndexerHealth = checkIndexerHealth;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const indexerHealthQuery = `
  query IndexerHealth {
    overviewSnapshotById(id: "singleton") {
      lastIndexedAt
      lastProcessedBlock
    }
  }
`;
async function checkIndexerHealth(graphqlUrl, timeoutMs, staleThresholdMs = STALE_THRESHOLD_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(graphqlUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operationName: 'IndexerHealth', query: indexerHealthQuery }),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`Indexer GraphQL responded with HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (payload.errors?.length) {
            throw new Error(`Indexer GraphQL error: ${payload.errors[0].message}`);
        }
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
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Indexer health probe timed out after ${timeoutMs}ms`);
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=indexerHealthProbe.js.map