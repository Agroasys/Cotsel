/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The indexer wire contract as treasury reads it. These shapes describe what
 * the indexer reports, not what treasury has verified: `blockNumber` and
 * `txHash` are claims about the chain until `chainCanonicality` re-derives the
 * block hash from the settlement RPC. They live beside the client that decodes
 * them rather than in the treasury domain types so the boundary stays visible.
 */
export interface IndexerTradeEvent {
  id: string;
  tradeId: string;
  eventName: string;
  txHash: string | null;
  blockNumber: number;
  logIndex: number;
  timestamp: Date;
  releasedLogisticsAmount?: string | null;
  paidPlatformFees?: string | null;
  paidPlatformFeeNet?: string | null;
  paidSettlementSupportFee?: string | null;
}

export interface IndexerTreasuryClaimEvent {
  id: string;
  eventName: 'TreasuryClaimed';
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: Date;
  claimAmount: string;
  treasuryIdentity: string;
  payoutReceiver: string;
  triggeredBy: string | null;
}
