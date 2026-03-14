import { config } from './config';
import { Logger } from './utils/logger';
import { closeConnection, testConnection } from './database/connection';
import { runMigrations } from './database/migrations';
import { ReconciliationService } from './core/reconciler';
import { assertRpcEndpointsReachable, redactRpcUrlForLogs } from './blockchain/rpc-preflight';
import { startHealthServer } from './health-server';

type Mode = 'once' | 'daemon';

function parseArgs(argv: string[]): { mode: Mode; runKey?: string } {
  const mode = argv[2] as Mode | undefined;

  if (!mode || (mode !== 'once' && mode !== 'daemon')) {
    throw new Error('Usage: ts-node src/cli.ts <once|daemon> [--run-key=<value>]');
  }

  const runKeyArg = argv.find((arg) => arg.startsWith('--run-key='));
  return {
    mode,
    runKey: runKeyArg ? runKeyArg.replace('--run-key=', '') : undefined,
  };
}

async function bootstrap(): Promise<void> {
  const { mode, runKey } = parseArgs(process.argv);

  Logger.info('Starting reconciliation worker', {
    mode,
    runKey,
    indexerGraphqlUrl: config.indexerGraphqlUrl,
  });

  await testConnection();
  await runMigrations();

  Logger.info('Validating RPC endpoint for reconciliation startup', {
    rpcUrl: redactRpcUrlForLogs(config.rpcUrl),
    fallbackRpcUrls: config.rpcFallbackUrls.map(redactRpcUrlForLogs),
  });
  await assertRpcEndpointsReachable([config.rpcUrl, ...config.rpcFallbackUrls]);

  const service = new ReconciliationService();

  if (mode === 'once') {
    await service.reconcileOnce('ONCE', runKey);
    await closeConnection();
    return;
  }

  const healthServer = startHealthServer();

  const shutdown = async (signal: string): Promise<void> => {
    Logger.warn('Received shutdown signal', { signal });
    healthServer.close();
    await closeConnection();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await service.runDaemon();
}

bootstrap().catch(async (error: any) => {
  Logger.error('Reconciliation bootstrap failed', {
    error: error?.message || error,
  });

  try {
    await closeConnection();
  } finally {
    process.exit(1);
  }
});
