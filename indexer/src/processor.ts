import { EvmBatchProcessor, type EvmBatchProcessorFields } from '@subsquid/evm-processor';
import { selectReachableRpcEndpoint, redactRpcUrlForLogs } from '@agroasys/sdk';
import { loadConfig } from './config';
import { ESCROW_EVENT_TOPICS } from './eventTopics';

const config = loadConfig();

export const ESCROW_ADDRESS = config.contractAddress;

// Subsquid's EvmBatchProcessor takes a single RPC URL (no FallbackProvider),
// so rotation happens at startup: we pick the first reachable endpoint from the
// configured priority list. These settings are shared between the initial
// processor build and the reachable-endpoint override applied in bootstrap.
function rpcEndpointSettings(url: string) {
  return {
    url,
    rateLimit: config.rateLimit,
    capacity: config.rpcCapacity ?? undefined,
    maxBatchCallSize: config.rpcMaxBatchCallSize ?? undefined,
    requestTimeout: config.rpcRequestTimeoutMs ?? undefined,
    retryAttempts: config.rpcRetryAttempts ?? undefined,
  };
}

const processor = new EvmBatchProcessor()
  .setBlockRange({
    from: config.startBlock,
  })
  .setRpcEndpoint(rpcEndpointSettings(config.rpcEndpoint))
  .setRpcDataIngestionSettings({
    disabled: config.rpcIngestDisabled,
    headPollInterval: config.rpcHeadPollIntervalMs ?? undefined,
  })
  .setFinalityConfirmation(config.finalityConfirmationBlocks)
  .addLog({
    address: [ESCROW_ADDRESS],
    topic0: ESCROW_EVENT_TOPICS,
    transaction: true,
  })
  .setFields({
    block: {
      timestamp: true,
    },
    transaction: {
      hash: true,
    },
    log: {
      address: true,
      topics: true,
      data: true,
    },
  });

if (config.gatewayUrl) {
  processor.setGateway(config.gatewayUrl);
}

if (config.prometheusPort !== null) {
  processor.setPrometheusPort(config.prometheusPort);
}

/**
 * Select the first reachable RPC endpoint from the configured priority list
 * (primary + fallbacks) and point the processor at it. Never throws: if none
 * answer, it keeps the primary so Subsquid's own retry can recover rather than
 * crash-looping the indexer.
 */
export async function applyReachableRpcEndpoint(): Promise<{ url: string; reachable: boolean }> {
  const endpoints = [config.rpcEndpoint, ...config.rpcFallbackEndpoints];
  if (endpoints.length === 1) {
    return { url: config.rpcEndpoint, reachable: true };
  }

  const selection = await selectReachableRpcEndpoint(endpoints, config.rpcRequestTimeoutMs ?? 3000);
  processor.setRpcEndpoint(rpcEndpointSettings(selection.url));
  console.log(
    JSON.stringify({
      level: selection.reachable ? 'info' : 'warn',
      service: 'indexer',
      message: selection.reachable
        ? 'Selected reachable RPC endpoint'
        : 'No RPC endpoint answered preflight; using primary and relying on retry',
      rpcUrl: redactRpcUrlForLogs(selection.url),
      checked: selection.checked,
    }),
  );
  return { url: selection.url, reachable: selection.reachable };
}

export { processor };

export type Fields = EvmBatchProcessorFields<typeof processor>;
