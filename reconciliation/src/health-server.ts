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
  const server = http.createServer(async (req, res) => {
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
        json(res, 200, {
          success: true,
          service: 'reconciliation',
          ready: true,
          lastRun,
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
