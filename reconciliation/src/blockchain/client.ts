import { OracleSDK, type Trade } from '@agroasys/sdk';
import { config } from '../config';

export class OnchainClient {
  private readonly sdk: OracleSDK;

  constructor() {
    this.sdk = new OracleSDK({
      rpc: config.rpcUrl,
      rpcFallbackUrls: config.rpcFallbackUrls,
      chainId: config.chainId,
      escrowAddress: config.escrowAddress,
      usdcAddress: config.usdcAddress,
    });
  }

  async getTrade(tradeId: string): Promise<Trade> {
    return this.sdk.getTrade(tradeId);
  }
}
