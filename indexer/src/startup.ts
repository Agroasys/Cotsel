import type { IndexerConfig } from './config';
import type { IndexerAlerts } from './alerts';
import {
  assertCheckpointOnChain,
  assertFinalitySupport,
  type ProcessorCheckpoint,
} from './chainReadiness';
import { assertContractPreflight, assertNoUnresolvedQuarantine } from './preflight';

export function logBootstrapEvent(
  level: 'info' | 'warn' | 'error',
  eventType: string,
  message: string,
  meta: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({ level, service: 'indexer', eventType, message, ...meta })}\n`,
  );
}

export interface StartupGateDeps {
  config: IndexerConfig;
  rpcUrl: string;
  quarantine: { countUnresolved(): Promise<number> };
  alerts: IndexerAlerts;
  readCheckpoint: () => Promise<ProcessorCheckpoint | null>;
}

/**
 * Every gate throws. The indexer must not begin projecting until the chain,
 * contract, finality model, stored checkpoint, and quarantine state are all
 * consistent with the reviewed configuration.
 */
export async function runStartupGates(deps: StartupGateDeps): Promise<void> {
  const { config, rpcUrl } = deps;
  const timeoutMs = config.rpcRequestTimeoutMs ?? undefined;

  const preflight = await assertContractPreflight(
    {
      rpcUrl,
      contractAddress: config.contractAddress,
      startBlock: config.startBlock,
      timeoutMs,
      expectedCodehash: config.expectedContractCodehash,
      expectedAbiFingerprint: config.expectedAbiFingerprint,
      verifyStartBlockCode: config.verifyStartBlockCode,
    },
    {
      warn: (message, meta) =>
        logBootstrapEvent('warn', 'contract.preflight_partial', message, meta),
    },
  );
  logBootstrapEvent('info', 'contract.preflight_passed', 'Contract preflight passed', {
    contractAddress: config.contractAddress,
    startBlock: config.startBlock,
    codehash: preflight.codehash,
    abiFingerprint: preflight.abiFingerprint,
    startBlockVerified: preflight.startBlockVerified,
  });

  const finality = await assertFinalitySupport(rpcUrl, timeoutMs);
  const checkpoint = await deps.readCheckpoint();
  const checkpointState = await assertCheckpointOnChain({
    rpcUrl,
    checkpoint,
    startBlock: config.startBlock,
    timeoutMs,
  });
  logBootstrapEvent('info', 'chain.preflight_passed', 'Finality and checkpoint preflight passed', {
    finalizedBlock: finality.finalizedBlock.toString(),
    head: finality.head.toString(),
    checkpointHeight: checkpoint?.height ?? null,
    checkpointState,
  });

  await assertNoUnresolvedQuarantine({
    quarantine: deps.quarantine,
    alerts: deps.alerts,
    logger: {
      error: (message, meta) =>
        logBootstrapEvent('error', 'quarantine.startup_blocked', message, meta ?? {}),
    },
  });
}
