process.env.PORT = process.env.PORT || '3200';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'treasury_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.INDEXER_GRAPHQL_URL =
  process.env.INDEXER_GRAPHQL_URL || 'http://127.0.0.1:3100/graphql';

import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import type { TreasuryController } from '../src/api/controller';
import { createRouter } from '../src/api/routes';
import type { IngestionFreshnessAssessment } from '../src/core/ingestionFreshness';
import { freshIngestionAssessment, staleIngestionAssessment } from './helpers/ingestionFreshness';

// The readiness and health routes never reach the controller, so the suite
// supplies a stand-in whose only job is to survive `createRouter`'s binding.
const stubController = new Proxy(
  {},
  {
    get: () => () => undefined,
  },
) as TreasuryController;

async function withServer(
  options: {
    readinessCheck?: () => Promise<void>;
    ingestionFreshnessCheck?: () => Promise<IngestionFreshnessAssessment>;
  },
  assertions: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/treasury/v1', createRouter(stubController, options));

  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  try {
    const { port } = server.address() as AddressInfo;
    await assertions(`http://127.0.0.1:${port}/api/treasury/v1`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * WP-4 B-09 / FAIL-10: the stopped-ingestion drill, at the probe.
 *
 * The finding is that treasury stayed green while its chain evidence stopped
 * advancing. Liveness and readiness are deliberately split rather than both
 * moving: the process really is alive, and killing it would not repair an
 * ingestion outage. What must change is the signal that says treasury is fit to
 * be exported, realized and closed against.
 */
describe('treasury readiness and ingestion freshness', () => {
  it('reports ready while ingestion is fresh', async () => {
    await withServer(
      {
        readinessCheck: async () => undefined,
        ingestionFreshnessCheck: async () => freshIngestionAssessment(),
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/ready`);
        const body = (await response.json()) as {
          ready: boolean;
          ingestion: { status: string; ageSeconds: number };
        };

        expect(response.status).toBe(200);
        expect(body.ready).toBe(true);
        expect(body.ingestion.status).toBe('FRESH');
        expect(body.ingestion.ageSeconds).toBe(30);
      },
    );
  });

  it('turns readiness unhealthy and names the cause when ingestion has stopped', async () => {
    await withServer(
      {
        readinessCheck: async () => undefined,
        ingestionFreshnessCheck: async () => staleIngestionAssessment(),
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/ready`);
        const body = (await response.json()) as {
          ready: boolean;
          error: string;
          ingestion: { status: string; blockedReasons: string[] };
        };

        expect(response.status).toBe(503);
        expect(body.ready).toBe(false);
        expect(body.error).toBe('Treasury chain-evidence ingestion is not fresh');
        expect(body.ingestion.status).toBe('STALE');
        expect(body.ingestion.blockedReasons).toEqual([
          'Treasury ingestion last completed 3600s ago, beyond the 900s freshness threshold.',
        ]);
      },
    );
  });

  it('blocks readiness when ingestion has never completed a run', async () => {
    await withServer(
      {
        readinessCheck: async () => undefined,
        ingestionFreshnessCheck: async () =>
          freshIngestionAssessment({
            status: 'NEVER_RUN',
            lastSuccessAt: null,
            ageSeconds: null,
            blockedReasons: ['Treasury ingestion has never completed a run for trade_events'],
          }),
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/ready`);
        const body = (await response.json()) as { ingestion: { lastSuccessAt: string | null } };

        expect(response.status).toBe(503);
        expect(body.ingestion.lastSuccessAt).toBeNull();
      },
    );
  });

  /**
   * Restarting a pod does not restart the chain. Liveness therefore stays green
   * through an ingestion outage, or an orchestrator would sit in a restart loop
   * that cannot fix the cause.
   */
  it('keeps liveness green while readiness is red', async () => {
    await withServer(
      {
        readinessCheck: async () => undefined,
        ingestionFreshnessCheck: async () => staleIngestionAssessment(),
      },
      async (baseUrl) => {
        const health = await fetch(`${baseUrl}/health`);
        const ready = await fetch(`${baseUrl}/ready`);

        expect(health.status).toBe(200);
        expect(ready.status).toBe(503);
      },
    );
  });

  it('still fails readiness when the database check throws, before freshness is consulted', async () => {
    const ingestionFreshnessCheck = jest.fn(async () => freshIngestionAssessment());

    await withServer(
      {
        readinessCheck: async () => {
          throw new Error('connection refused');
        },
        ingestionFreshnessCheck,
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/ready`);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(503);
        expect(body.error).toBe('Dependencies not ready');
        expect(ingestionFreshnessCheck).not.toHaveBeenCalled();
      },
    );
  });
});
