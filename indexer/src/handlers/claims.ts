import { OverviewSnapshot, SystemEvent, Trade, TradeEvent } from '../model';
import {
  CLAIM_TYPE_VALUES,
  getOrLoadTrade,
  type DecodedEscrowLog,
  type IndexerBlock,
  type IndexerContext,
} from '../handlerContext';

export async function handleClaimableAccrued(
  log: DecodedEscrowLog,
  trades: Map<string, Trade>,
  events: TradeEvent[],
  overviewSnapshot: OverviewSnapshot,
  eventId: string,
  block: IndexerBlock,
  timestamp: Date,
  txHash: string,
  logIndex: number,
  transactionIndex: number,
  ctx: IndexerContext,
) {
  const [tradeId, recipient, amount, claimType] = log.args;

  const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);

  const claimTypeEnum = CLAIM_TYPE_VALUES[Number(claimType)] ?? null;
  overviewSnapshot.lastTradeEventAt = timestamp;

  events.push(
    new TradeEvent({
      id: eventId,
      trade,
      eventName: 'ClaimableAccrued',
      blockNumber: block.header.height,
      timestamp,
      txHash,
      logIndex,
      transactionIndex,
      claimType: claimTypeEnum,
      claimRecipient: recipient.toLowerCase(),
      claimAmount: amount,
    }),
  );

  ctx.log.info(
    `Trade ${tradeId} claimable accrued: ${amount} to ${recipient} (type: ${claimTypeEnum})`,
  );
  return overviewSnapshot;
}

export async function handleTreasuryClaimed(
  log: DecodedEscrowLog,
  events: SystemEvent[],
  eventId: string,
  block: IndexerBlock,
  timestamp: Date,
  txHash: string,
  logIndex: number,
  transactionIndex: number,
  ctx: IndexerContext,
) {
  const [treasuryIdentity, payoutReceiver, amount, triggeredBy] = log.args;

  events.push(
    new SystemEvent({
      id: eventId,
      eventName: 'TreasuryClaimed',
      blockNumber: block.header.height,
      timestamp,
      txHash,
      logIndex,
      transactionIndex,
      triggeredBy: triggeredBy.toLowerCase(),
      claimAmount: amount,
      treasuryIdentity: treasuryIdentity.toLowerCase(),
      payoutReceiver: payoutReceiver.toLowerCase(),
    }),
  );

  ctx.log.info(`Treasury claimed ${amount} to ${payoutReceiver} by ${triggeredBy}`);
}

export async function handleTreasuryPayoutAddressUpdateProposed(
  log: DecodedEscrowLog,
  events: SystemEvent[],
  eventId: string,
  block: IndexerBlock,
  timestamp: Date,
  txHash: string,
  logIndex: number,
  transactionIndex: number,
  ctx: IndexerContext,
) {
  const [proposalId, proposer, newPayoutReceiver, eta] = log.args;

  events.push(
    new SystemEvent({
      id: eventId,
      eventName: 'TreasuryPayoutAddressUpdateProposed',
      blockNumber: block.header.height,
      timestamp,
      txHash,
      logIndex,
      transactionIndex,
      proposalId: proposalId.toString(),
      triggeredBy: proposer.toLowerCase(),
      newPayoutReceiver: newPayoutReceiver.toLowerCase(),
      payoutReceiver: newPayoutReceiver.toLowerCase(),
      eta,
    }),
  );

  ctx.log.info(
    `Treasury payout receiver update proposed: proposal=${proposalId} newReceiver=${newPayoutReceiver}`,
  );
}

export async function handleTreasuryPayoutAddressUpdateApproved(
  log: DecodedEscrowLog,
  events: SystemEvent[],
  eventId: string,
  block: IndexerBlock,
  timestamp: Date,
  txHash: string,
  logIndex: number,
  transactionIndex: number,
  ctx: IndexerContext,
) {
  const [proposalId, approver, approvalCount, requiredApprovals] = log.args;

  events.push(
    new SystemEvent({
      id: eventId,
      eventName: 'TreasuryPayoutAddressUpdateApproved',
      blockNumber: block.header.height,
      timestamp,
      txHash,
      logIndex,
      transactionIndex,
      proposalId: proposalId.toString(),
      triggeredBy: approver.toLowerCase(),
      approvalCount: Number(approvalCount),
      requiredApprovals: Number(requiredApprovals),
    }),
  );

  ctx.log.info(
    `Treasury payout receiver update approved: proposal=${proposalId} approver=${approver} approvals=${approvalCount}/${requiredApprovals}`,
  );
}

export async function handleTreasuryPayoutAddressUpdated(
  log: DecodedEscrowLog,
  events: SystemEvent[],
  eventId: string,
  block: IndexerBlock,
  timestamp: Date,
  txHash: string,
  logIndex: number,
  transactionIndex: number,
  ctx: IndexerContext,
) {
  const [oldPayoutReceiver, newPayoutReceiver] = log.args;

  events.push(
    new SystemEvent({
      id: eventId,
      eventName: 'TreasuryPayoutAddressUpdated',
      blockNumber: block.header.height,
      timestamp,
      txHash,
      logIndex,
      transactionIndex,
      oldPayoutReceiver: oldPayoutReceiver.toLowerCase(),
      newPayoutReceiver: newPayoutReceiver.toLowerCase(),
      payoutReceiver: newPayoutReceiver.toLowerCase(),
    }),
  );

  ctx.log.info(
    `Treasury payout receiver updated: old=${oldPayoutReceiver} new=${newPayoutReceiver}`,
  );
}

export async function handleTreasuryPayoutAddressUpdateProposalExpiredCancelled(
  log: DecodedEscrowLog,
  events: SystemEvent[],
  eventId: string,
  block: IndexerBlock,
  timestamp: Date,
  txHash: string,
  logIndex: number,
  transactionIndex: number,
  ctx: IndexerContext,
) {
  const [proposalId, cancelledBy] = log.args;

  events.push(
    new SystemEvent({
      id: eventId,
      eventName: 'TreasuryPayoutAddressUpdateProposalExpiredCancelled',
      blockNumber: block.header.height,
      timestamp,
      txHash,
      logIndex,
      transactionIndex,
      proposalId: proposalId.toString(),
      triggeredBy: cancelledBy.toLowerCase(),
    }),
  );

  ctx.log.info(
    `Treasury payout receiver update proposal expired and cancelled: proposal=${proposalId} by=${cancelledBy}`,
  );
}

export async function handleClaimsPaused(
  log: DecodedEscrowLog,
  events: SystemEvent[],
  eventId: string,
  block: IndexerBlock,
  timestamp: Date,
  txHash: string,
  logIndex: number,
  transactionIndex: number,
  ctx: IndexerContext,
) {
  const [triggeredBy] = log.args;

  events.push(
    new SystemEvent({
      id: eventId,
      eventName: 'ClaimsPaused',
      blockNumber: block.header.height,
      timestamp,
      txHash,
      logIndex,
      transactionIndex,
      triggeredBy: triggeredBy.toLowerCase(),
    }),
  );

  ctx.log.info(`Claims paused by ${triggeredBy}`);
}

export async function handleClaimsUnpaused(
  log: DecodedEscrowLog,
  events: SystemEvent[],
  eventId: string,
  block: IndexerBlock,
  timestamp: Date,
  txHash: string,
  logIndex: number,
  transactionIndex: number,
  ctx: IndexerContext,
) {
  const [triggeredBy] = log.args;

  events.push(
    new SystemEvent({
      id: eventId,
      eventName: 'ClaimsUnpaused',
      blockNumber: block.header.height,
      timestamp,
      txHash,
      logIndex,
      transactionIndex,
      triggeredBy: triggeredBy.toLowerCase(),
    }),
  );

  ctx.log.info(`Claims unpaused by ${triggeredBy}`);
}
