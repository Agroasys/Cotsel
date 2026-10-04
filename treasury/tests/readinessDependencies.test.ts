process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import express from 'express';
import type { AddressInfo } from 'net';
import type { TreasuryController } from '../src/api/controller';
import { createRouter } from '../src/api/routes';
import { ReconciliationGateService } from '../src/core/reconciliationGate';
import { createTreasuryReadinessCheck } from '../src/readiness';
import { freshIngestionAssessment } from './helpers/ingestionFreshness';

const stubController = new Proxy({}, { get: () => () => undefined }) as TreasuryController;
const ok = async () => {};

async function getReady(options: Parameters<typeof createRouter>[1]) {
  const app = express();
  app.use('/api/treasury/v1', createRouter(stubController, options));
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/treasury/v1/ready`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

describe('treasury dependency readiness', () => {
  it('requires the reconciliation reader only when one is configured', async () => {
    const withoutReader = await createTreasuryReadinessCheck({ database: ok })();
    expect(withoutReader.dependencies.map((dependency) => dependency.name)).toEqual(['postgres']);

    const withReader = await createTreasuryReadinessCheck({ database: ok, reconciliation: ok })();
    expect(withReader.dependencies.map((dependency) => dependency.name)).toEqual([
      'postgres',
      'reconciliation-reader',
    ]);
    expect(withReader.ready).toBe(true);
  });

  it('returns 503 with the failing dependency before assessing ingestion', async () => {
    const ingestionFreshnessCheck = jest.fn(async () => freshIngestionAssessment());
    const { status, body } = await getReady({
      readinessCheck: createTreasuryReadinessCheck({
        database: ok,
        reconciliation: async () => {
          throw new Error('password authentication failed for user cotsel_reconciliation_reader');
        },
      }),
      ingestionFreshnessCheck,
    });

    expect(status).toBe(503);
    expect(body).toMatchObject({ ready: false, error: 'Dependencies not ready' });
    expect(body.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'reconciliation-reader', status: 'unavailable' }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('cotsel_reconciliation_reader');
    expect(ingestionFreshnessCheck).not.toHaveBeenCalled();
  });

  it('reports dependencies alongside fresh ingestion when ready', async () => {
    const { status, body } = await getReady({
      readinessCheck: createTreasuryReadinessCheck({ database: ok, reconciliation: ok }),
      ingestionFreshnessCheck: async () => freshIngestionAssessment(),
    });

    expect(status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.dependencies).toHaveLength(2);
  });

  it('probes the reconciliation reader and refuses an unconfigured one', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const configured = new ReconciliationGateService({ pool: { query } as never });
    expect(configured.isConfigured()).toBe(true);
    await expect(configured.checkReadiness()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('SELECT 1');

    const unconfigured = new ReconciliationGateService({ pool: null });
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(unconfigured.checkReadiness()).rejects.toThrow('not configured');
  });
});
