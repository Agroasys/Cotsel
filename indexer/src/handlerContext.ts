import type { BlockData, DataHandlerContext } from '@subsquid/evm-processor';
import type { Store } from '@subsquid/typeorm-store';
import { contractInterface } from './abi';
import { type Fields } from './processor';
import { ClaimType, Trade } from './model';

export type IndexerContext = DataHandlerContext<Store, Fields>;
export type IndexerBlock = BlockData<Fields>;
export type DecodedEscrowLog = NonNullable<ReturnType<typeof contractInterface.parseLog>>;

export const CLAIM_TYPE_VALUES = Object.values(ClaimType);

// helper
export async function getOrLoadTrade(
  tradeId: string,
  trades: Map<string, Trade>,
  ctx: IndexerContext,
): Promise<Trade> {
  let trade = trades.get(tradeId);
  if (trade) {
    return trade;
  }

  trade = await ctx.store.get(Trade, tradeId);
  if (trade) {
    trades.set(tradeId, trade);
    return trade;
  }

  throw new Error(
    `Required parent trade ${tradeId} is missing; hold the checkpoint and replay after correcting event coverage`,
  );
}
