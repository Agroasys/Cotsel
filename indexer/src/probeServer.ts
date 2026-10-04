import { createServer, type Server, type ServerResponse } from 'node:http';
import type { ReadinessResult } from '@agroasys/shared-edge';

export interface ProbeServerOptions {
  port: number;
  host?: string;
  readiness: () => Promise<ReadinessResult>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/**
 * `/health` is liveness and depends on nothing outside the process, so a dead
 * RPC or stale checkpoint never makes the orchestrator restart the indexer.
 * `/ready` reports whether the projection may be trusted right now.
 */
export function createProbeServer(options: Pick<ProbeServerOptions, 'readiness'>): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    if (path === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'indexer' });
      return;
    }

    if (path === '/ready') {
      options.readiness().then(
        (result) => sendJson(response, result.ready ? 200 : 503, { service: 'indexer', ...result }),
        () => sendJson(response, 503, { service: 'indexer', ready: false, dependencies: [] }),
      );
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
}

export function startProbeServer(options: ProbeServerOptions): Promise<Server> {
  const server = createProbeServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
