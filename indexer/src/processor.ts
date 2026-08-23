import { EvmBatchProcessor, type EvmBatchProcessorFields } from '@subsquid/evm-processor';
import { selectReachableRpcEndpoint, redactRpcUrlForLogs } from './rpc-preflight';
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
 * Select the first RPC endpoint on the configured chain and point the processor
 * at it. Fail closed if no endpoint returns the expected chain ID.
 */
export async function applyReachableRpcEndpoint(): Promise<{ url: string; reachable: boolean }> {
  const endpoints = [config.rpcEndpoint, ...config.rpcFallbackEndpoints];
  const selection = await selectReachableRpcEndpoint(
    endpoints,
    config.chainId,
    config.rpcRequestTimeoutMs ?? 3000,
  );
  processor.setRpcEndpoint(rpcEndpointSettings(selection.url));
  console.log(
    JSON.stringify({
      level: selection.checked > 1 ? 'warn' : 'info',
      service: 'indexer',
      eventType: selection.checked > 1 ? 'rpc.fallback_selected' : 'rpc.primary_selected',
      message:
        selection.checked > 1 ? 'Selected fallback RPC endpoint' : 'Selected primary RPC endpoint',
      rpcUrl: redactRpcUrlForLogs(selection.url),
      checked: selection.checked,
      chainId: config.chainId,
    }),
  );
  return { url: selection.url, reachable: selection.reachable };
}

export { processor };

export type Fields = EvmBatchProcessorFields<typeof processor>;
