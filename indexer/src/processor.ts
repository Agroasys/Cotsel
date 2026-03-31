import { EvmBatchProcessor, type EvmBatchProcessorFields } from '@subsquid/evm-processor';
import { loadConfig } from './config';
import { ESCROW_EVENT_TOPICS } from './eventTopics';

const config = loadConfig();

export const ESCROW_ADDRESS = config.contractAddress;

const processor = new EvmBatchProcessor()
  .setBlockRange({
    from: config.startBlock,
  })
  .setRpcEndpoint({
    url: config.rpcEndpoint,
    rateLimit: config.rateLimit,
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

export { processor };

export type Fields = EvmBatchProcessorFields<typeof processor>;
