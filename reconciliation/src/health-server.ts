/**
 * SPDX-License-Identifier: Apache-2.0
 */
import http from 'http';
import { pool, testConnection } from './database/connection';

const HEALTH_PORT = parseInt(process.env.RECONCILIATION_HEALTH_PORT ?? '9090', 10);

interface LastRunRow {
  run_key: string;
  mode: string;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  drift_count: number;
  critical_count: number;
  error_message: string | null;
}

/**
 * Counts an operator needs to see without opening a psql session: work that is
 * stuck, and trades that are blocked.
 *
 * Neither count changes the readiness verdict. The service is ready when its
 * dependencies answer; an abandoned run or a contained trade is a condition in
 * the data for an owner to act on, not a reason to take this process out of
 * rotation.
 */
async function queryControlCounts(): Promise<{
  abandonedRuns: number;
  blockingContainments: number;
}> {
  const result = await pool.query<{ abandoned_runs: string; blocking_containments: string }>(`
    SELECT
      (SELECT COUNT(*) FROM reconcile_runs WHERE status = 'ABANDONED') AS abandoned_runs,
      (SELECT COUNT(*) FROM reconcile_trade_containments WHERE state <> 'RELEASED')
        AS blocking_containments
  `);

  return {
    abandonedRuns: Number(result.rows[0].abandoned_runs),
    blockingContainments: Number(result.rows[0].blocking_containments),
  };
}

async function queryLastRun(): Promise<LastRunRow | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<LastRunRow>(`
      SELECT run_key, mode, status, started_at, completed_at,
             drift_count, critical_count, error_message
      FROM reconcile_runs
      ORDER BY id DESC
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }

      const timestamp = new Date().toISOString();

      if (req.url === '/health') {
        json(res, 200, { success: true, service: 'reconciliation', status: 'ok', timestamp });
        return;
      }

      if (req.url === '/ready') {
        try {
          await testConnection();
          const lastRun = await queryLastRun();
          const controls = await queryControlCounts();
          json(res, 200, {
            success: true,
            service: 'reconciliation',
            ready: true,
            lastRun,
            ...controls,
            timestamp,
          });
        } catch (error) {
          json(res, 503, {
            success: false,
            service: 'reconciliation',
            ready: false,
            error: error instanceof Error ? error.message : 'Dependency unavailable',
            timestamp,
          });
        }
        return;
      }

      res.writeHead(404);
      res.end();
    })();
  });

  server.listen(HEALTH_PORT, () => {
    process.stdout.write(
      JSON.stringify({
        level: 'info',
        service: 'reconciliation',
        message: 'Health server started',
        port: HEALTH_PORT,
      }) + '\n',
    );
  });

  return server;
}
