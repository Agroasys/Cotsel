import { createIndexerReadinessCheck, type IndexerReadinessDependencies } from './chainReadiness';
import type { IndexerConfig } from './config';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { ReadinessResult } from '@agroasys/shared-edge';

export interface ProbeServerOptions {
  port: number;
  host?: string;
  readiness: () => Promise<ReadinessResult>;
  coverage?: () => Promise<{
    chainId: string;
    escrowAddress: string;
    blockNumber: string;
    blockHash: string;
  } | null>;
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
export function createProbeServer(
  options: Pick<ProbeServerOptions, 'readiness' | 'coverage'>,
): Server {
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

    if (path === '/coverage') {
      void (async () => {
        try {
          const ready = await options.readiness();
          const checkpoint = ready.ready ? await options.coverage?.() : null;
          sendJson(response, checkpoint ? 200 : 503, {
            service: 'indexer',
            ready: Boolean(checkpoint),
            checkpoint: checkpoint ?? null,
            observedAt: new Date().toISOString(),
          });
        } catch {
          sendJson(response, 503, { service: 'indexer', ready: false, checkpoint: null });
        }
      })();
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

/** The retained processor checkpoint is the sole indexing coverage authority. */
export function createIndexerCoverageRead(
  config: { chainId: number; contractAddress: string },
  read: () => Promise<{ height: number; hash: string } | null>,
): NonNullable<ProbeServerOptions['coverage']> {
  return async () => {
    const checkpoint = await read();
    return checkpoint && checkpoint.height >= 0 && /^0x[0-9a-f]{64}$/i.test(checkpoint.hash)
      ? {
          chainId: String(config.chainId),
          escrowAddress: config.contractAddress,
          blockNumber: String(checkpoint.height),
          blockHash: checkpoint.hash.toLowerCase(),
        }
      : null;
  };
}

export function createIndexerProbeOptions(
  config: IndexerConfig,
  dependencies: Pick<
    IndexerReadinessDependencies,
    'startupComplete' | 'rpcUrl' | 'readCheckpoint' | 'countUnresolvedQuarantine'
  >,
): ProbeServerOptions {
  return {
    port: config.readinessPort,
    coverage: createIndexerCoverageRead(config, dependencies.readCheckpoint),
    readiness: createIndexerReadinessCheck({
      ...dependencies,
      chainId: config.chainId,
      finalityConfirmationBlocks: config.finalityConfirmationBlocks,
      maxCheckpointLagBlocks: config.readinessMaxCheckpointLagBlocks,
      startBlock: config.startBlock,
      rpcTimeoutMs: config.rpcRequestTimeoutMs ?? undefined,
    }),
  };
}
