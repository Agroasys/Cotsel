import { TypeormDatabase } from '@subsquid/typeorm-store'
import { processor, ESCROW_ADDRESS } from './processor'
import { contractInterface } from './abi'
import {
    Trade,
    TradeEvent,
    DisputeProposal,
    DisputeEvent,
    OracleUpdateProposal,
    OracleEvent,
    AdminAddProposal,
    AdminEvent,
    SystemEvent,
    TradeStatus,
    DisputeStatus,
    ClaimType
} from './model'
import { assertNoExtrinsicFallbackAsTxHash, resolveEventHashes } from './utils/eventHashes';

processor.run(new TypeormDatabase(), async (ctx) => {
    const trades: Map<string, Trade> = new Map();
    const tradeEvents: TradeEvent[] = [];
    const disputeProposals: Map<string, DisputeProposal> = new Map();
    const disputeEvents: DisputeEvent[] = [];
    const oracleUpdateProposals: Map<string, OracleUpdateProposal> = new Map();
    const oracleEvents: OracleEvent[] = [];
    const adminAddProposals: Map<string, AdminAddProposal> = new Map();
    const adminEvents: AdminEvent[] = [];
    const systemEvents: SystemEvent[] = [];

    for (let block of ctx.blocks) {
        for (let event of block.events) {
            if (event.name !== 'Revive.ContractEmitted') {
                continue;
            }
            try {
                const { contract, data, topics } = event.args;

                if (contract.toLowerCase() !== ESCROW_ADDRESS) {
                    continue;
                }

                const decoded = contractInterface.parseLog({ topics, data });

                if (!decoded) {
                    ctx.log.warn(`Failed to decode event at block ${block.header.height}`);
                    continue;
                }

                const eventId = event.id;
                const timestamp = new Date(block.header.timestamp || 0);
                const extrinsic = block.extrinsics.find(e => e.index === event.extrinsicIndex);
                const eventHashes = resolveEventHashes(extrinsic);
                assertNoExtrinsicFallbackAsTxHash(eventHashes);
                const { txHash, extrinsicHash } = eventHashes;
                const extrinsicIndex = event.extrinsicIndex || 0;

                if (!txHash && extrinsicHash) {
                    ctx.log.warn(`EVM tx hash unavailable at block ${block.header.height} eventId=${eventId} extrinsicIndex=${event.extrinsicIndex ?? 'n/a'} extrinsicHash=${extrinsicHash}`);
                }

                switch (decoded.name) {
                    // Trade events
                    case 'TradeLocked':
                        await handleTradeLocked(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'FundsReleasedStage1':
                        await handleFundsReleasedStage1(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'PlatformFeesPaidStage1':
                        await handlePlatformFeesPaidStage1(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'ArrivalConfirmed':
                        await handleArrivalConfirmed(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'FinalTrancheReleased':
                        await handleFinalTrancheReleased(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'DisputeOpenedByBuyer':
                        await handleDisputeOpenedByBuyer(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'TradeCancelledAfterLockTimeout':
                        await handleTradeCancelledAfterLockTimeout(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'InTransitTimeoutRefunded':
                        await handleInTransitTimeoutRefunded(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;

                    // Dispute events
                    case 'DisputeSolutionProposed':
                        await handleDisputeSolutionProposed(decoded, trades, disputeProposals, disputeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'DisputeApproved':
                        await handleDisputeApproved(decoded, disputeProposals, disputeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'DisputeFinalized':
                        await handleDisputeFinalized(decoded, disputeProposals, disputeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'DisputeProposalExpiredCancelled':
                        await handleDisputeProposalExpiredCancelled(decoded, disputeProposals, disputeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'DisputePayout':
                        await handleDisputePayout(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;

                    // Oracle events
                    case 'OracleUpdateProposed':
                        await handleOracleUpdateProposed(decoded, oracleUpdateProposals, oracleEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'OracleUpdateApproved':
                        await handleOracleUpdateApproved(decoded, oracleUpdateProposals, oracleEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'OracleUpdated':
                        await handleOracleUpdated(decoded, oracleEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'OracleUpdateProposalExpiredCancelled':
                        await handleOracleUpdateProposalExpiredCancelled(decoded, oracleUpdateProposals, oracleEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'OracleDisabledEmergency':
                        await handleOracleDisabledEmergency(decoded, oracleEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;

                    // Admin events
                    case 'AdminAddProposed':
                        await handleAdminAddProposed(decoded, adminAddProposals, adminEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'AdminAddApproved':
                        await handleAdminAddApproved(decoded, adminAddProposals, adminEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'AdminAdded':
                        await handleAdminAdded(decoded, adminEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'AdminAddProposalExpiredCancelled':
                        await handleAdminAddProposalExpiredCancelled(decoded, adminAddProposals, adminEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;

                    // System events
                    case 'Paused':
                        await handlePaused(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'UnpauseProposed':
                        await handleUnpauseProposed(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'UnpauseApproved':
                        await handleUnpauseApproved(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'UnpauseProposalCancelled':
                        await handleUnpauseProposalCancelled(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'Unpaused':
                        await handleUnpaused(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'ClaimsPaused':
                        await handleClaimsPaused(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'ClaimsUnpaused':
                        await handleClaimsUnpaused(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'Claimed':
                        await handleClaimed(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'TreasuryClaimed':
                        await handleTreasuryClaimed(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'TreasuryPayoutAddressUpdateProposed':
                        await handleTreasuryPayoutAddressUpdateProposed(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'TreasuryPayoutAddressUpdateApproved':
                        await handleTreasuryPayoutAddressUpdateApproved(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'TreasuryPayoutAddressUpdated':
                        await handleTreasuryPayoutAddressUpdated(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'TreasuryPayoutAddressUpdateProposalExpiredCancelled':
                        await handleTreasuryPayoutAddressUpdateProposalExpiredCancelled(decoded, systemEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;
                    case 'ClaimableAccrued':
                        await handleClaimableAccrued(decoded, trades, tradeEvents, eventId, block, timestamp, txHash, extrinsicHash, extrinsicIndex, ctx);
                        break;

                    default:
                        ctx.log.debug(`Unhandled event: ${decoded.name}`);
                }
            } catch (e) {
                ctx.log.error(`Error at block ${block.header.height}: ${e}`);
            }
        }
    }

    // save to db
    await ctx.store.upsert([...trades.values()]);
    await ctx.store.insert(tradeEvents);
    await ctx.store.upsert([...disputeProposals.values()]);
    await ctx.store.insert(disputeEvents);
    await ctx.store.upsert([...oracleUpdateProposals.values()]);
    await ctx.store.insert(oracleEvents);
    await ctx.store.upsert([...adminAddProposals.values()]);
    await ctx.store.insert(adminEvents);
    await ctx.store.insert(systemEvents);

    ctx.log.info(`Processed ${trades.size} trades, ${tradeEvents.length} trade events, ${disputeProposals.size} dispute proposals, ${disputeEvents.length} dispute events, ${oracleUpdateProposals.size} oracle proposals, ${oracleEvents.length} oracle events, ${adminAddProposals.size} admin proposals, ${adminEvents.length} admin events, ${systemEvents.length} system events`);
});

// helper
async function getOrLoadTrade(tradeId: string, trades: Map<string, Trade>, ctx: any): Promise<Trade | null> {
    let trade = trades.get(tradeId);
    if (trade) {
        return trade;
    }

    trade = await ctx.store.get(Trade, tradeId);
    if (trade) {
        trades.set(tradeId, trade);
        return trade;
    }

    return null;
}

// ########################### trade events ##########################

async function handleTradeLocked(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [
        tradeId,
        buyer,
        supplier,
        totalAmount,
        logisticsAmount,
        platformFeesAmount,
        supplierFirstTranche,
        supplierSecondTranche,
        ricardianHash
    ] = log.args;

    const trade = new Trade({
        id: tradeId.toString(),
        tradeId: tradeId.toString(),
        buyer: buyer.toLowerCase(),
        supplier: supplier.toLowerCase(),
        status: TradeStatus.LOCKED,
        totalAmountLocked: totalAmount,
        logisticsAmount: logisticsAmount,
        platformFeesAmount: platformFeesAmount,
        supplierFirstTranche: supplierFirstTranche,
        supplierSecondTranche: supplierSecondTranche,
        ricardianHash: ricardianHash,
        createdAt: timestamp
    });

    trades.set(tradeId.toString(), trade);

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'TradeLocked',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        totalAmount: totalAmount,
        logisticsAmount: logisticsAmount,
        platformFeesAmount: platformFeesAmount,
        supplierFirstTranche: supplierFirstTranche,
        supplierSecondTranche: supplierSecondTranche
    }));

    ctx.log.info(`Trade ${tradeId} locked by ${buyer}`);
}

async function handleFundsReleasedStage1(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId, , supplierFirstTranche, treasury, logisticsAmount] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for FundsReleasedStage1 event`);
        return;
    }

    trade.status = TradeStatus.IN_TRANSIT;
    trades.set(tradeId.toString(), trade);

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'FundsReleasedStage1',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        releasedFirstTranche: supplierFirstTranche,
        releasedLogisticsAmount: logisticsAmount,
        treasuryAddress: treasury.toLowerCase()
    }));

    ctx.log.info(`Trade ${tradeId} -> IN_TRANSIT`);
}

async function handlePlatformFeesPaidStage1(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId, treasury, platformFeesAmount] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for PlatformFeesPaidStage1 event`);
        return;
    }

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'PlatformFeesPaidStage1',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        paidPlatformFees: platformFeesAmount,
        treasuryAddress: treasury.toLowerCase()
    }));

    ctx.log.info(`Trade ${tradeId} platform fees paid: ${platformFeesAmount}`);
}

async function handleArrivalConfirmed(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId, arrivalTimestamp] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for ArrivalConfirmed event`);
        return;
    }

    trade.status = TradeStatus.ARRIVAL_CONFIRMED;
    trade.arrivalTimestamp = new Date(Number(arrivalTimestamp) * 1000);
    trades.set(tradeId.toString(), trade);

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'ArrivalConfirmed',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        arrivalTimestamp: arrivalTimestamp
    }));

    ctx.log.info(`Trade ${tradeId} arrival confirmed at ${arrivalTimestamp}`);
}

async function handleFinalTrancheReleased(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId, supplier, supplierSecondTranche] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for FinalTrancheReleased event`);
        return;
    }

    trade.status = TradeStatus.CLOSED;
    trades.set(tradeId.toString(), trade);

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'FinalTrancheReleased',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        finalTranche: supplierSecondTranche,
        finalRecipient: supplier.toLowerCase()
    }));

    ctx.log.info(`Trade ${tradeId} finalized - final tranche released to ${supplier}`);
}

async function handleDisputeOpenedByBuyer(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for DisputeOpenedByBuyer event`);
        return;
    }

    trade.status = TradeStatus.FROZEN;
    trades.set(tradeId.toString(), trade);

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'DisputeOpenedByBuyer',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex
    }));

    ctx.log.info(`Trade ${tradeId} frozen - dispute opened by buyer`);
}

async function handleTradeCancelledAfterLockTimeout(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId, buyer, refundedAmount] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for TradeCancelledAfterLockTimeout event`);
        return;
    }

    trade.status = TradeStatus.CLOSED;
    trades.set(tradeId.toString(), trade);

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'TradeCancelledAfterLockTimeout',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        refundedAmount: refundedAmount,
        refundedTo: buyer.toLowerCase()
    }));

    ctx.log.info(`Trade ${tradeId} cancelled after lock timeout - refunded ${refundedAmount} to ${buyer}`);
}

async function handleInTransitTimeoutRefunded(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId, buyer, refundedAmount] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for InTransitTimeoutRefunded event`);
        return;
    }

    trade.status = TradeStatus.CLOSED;
    trades.set(tradeId.toString(), trade);

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'InTransitTimeoutRefunded',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        refundedBuyerPrincipal: refundedAmount,
        refundedTo: buyer.toLowerCase()
    }));

    ctx.log.info(`Trade ${tradeId} in-transit timeout - refunded ${refundedAmount} to ${buyer}`);
}

// ########################### dispute events ##########################

async function handleDisputeSolutionProposed(
    log: any,
    trades: Map<string, Trade>,
    disputeProposals: Map<string, DisputeProposal>,
    events: DisputeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, tradeId, disputeStatus, proposer] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for DisputeSolutionProposed event`);
        return;
    }

    const disputeStatusEnum = disputeStatus === 0 ? DisputeStatus.REFUND : DisputeStatus.RESOLVE;

    // Calculate expiration (7 days TTL)
    const DISPUTE_PROPOSAL_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
    const expiresAt = new Date(timestamp.getTime() + DISPUTE_PROPOSAL_TTL);

    const proposal = new DisputeProposal({
        id: proposalId.toString(),
        proposalId: proposalId.toString(),
        trade,
        disputeStatus: disputeStatusEnum,
        approvalCount: 1,
        executed: false,
        createdAt: timestamp,
        proposer: proposer.toLowerCase(),
        expiresAt: expiresAt,
        cancelled: false
    });

    disputeProposals.set(proposalId.toString(), proposal);

    events.push(new DisputeEvent({
        id: eventId,
        dispute: proposal,
        eventName: 'DisputeSolutionProposed',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        proposedDisputeStatus: disputeStatusEnum,
        proposer: proposer.toLowerCase()
    }));

    ctx.log.info(`Dispute solution proposed: proposal ${proposalId} for trade ${tradeId} with status ${disputeStatusEnum}`);
}

async function handleDisputeApproved(
    log: any,
    disputeProposals: Map<string, DisputeProposal>,
    events: DisputeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, approver, approvalCount, requiredApprovals] = log.args;

    let proposal = disputeProposals.get(proposalId.toString());
    if (!proposal) {
        proposal = await ctx.store.get(DisputeProposal, proposalId.toString());
        if (!proposal) {
            ctx.log.error(`Dispute proposal ${proposalId} not found for DisputeApproved event`);
            return;
        }
        disputeProposals.set(proposalId.toString(), proposal);
    }

    proposal.approvalCount = Number(approvalCount);
    disputeProposals.set(proposalId.toString(), proposal);

    events.push(new DisputeEvent({
        id: eventId,
        dispute: proposal,
        eventName: 'DisputeApproved',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        approver: approver.toLowerCase(),
        approvalCount: Number(approvalCount),
        requiredApprovals: Number(requiredApprovals)
    }));

    ctx.log.info(`Dispute proposal ${proposalId} approved by ${approver} - ${approvalCount}/${requiredApprovals}`);
}

async function handleDisputeFinalized(
    log: any,
    disputeProposals: Map<string, DisputeProposal>,
    events: DisputeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, tradeId, disputeStatus] = log.args;

    let proposal = disputeProposals.get(proposalId.toString());
    if (!proposal) {
        proposal = await ctx.store.get(DisputeProposal, proposalId.toString());
        if (!proposal) {
            ctx.log.error(`Dispute proposal ${proposalId} not found for DisputeFinalized event`);
            return;
        }
        disputeProposals.set(proposalId.toString(), proposal);
    }

    proposal.executed = true;
    disputeProposals.set(proposalId.toString(), proposal);

    const disputeStatusEnum = disputeStatus === 0 ? DisputeStatus.REFUND : DisputeStatus.RESOLVE;

    events.push(new DisputeEvent({
        id: eventId,
        dispute: proposal,
        eventName: 'DisputeFinalized',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        finalDisputeStatus: disputeStatusEnum
    }));

    ctx.log.info(`Dispute ${proposalId} finalized for trade ${tradeId} with status ${disputeStatusEnum}`);
}

async function handleDisputeProposalExpiredCancelled(
    log: any,
    disputeProposals: Map<string, DisputeProposal>,
    events: DisputeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, tradeId, cancelledBy] = log.args;

    let proposal = disputeProposals.get(proposalId.toString());
    if (!proposal) {
        proposal = await ctx.store.get(DisputeProposal, proposalId.toString());
        if (!proposal) {
            ctx.log.error(`Dispute proposal ${proposalId} not found for ExpiredCancelled event`);
            return;
        }
        disputeProposals.set(proposalId.toString(), proposal);
    }

    proposal.cancelled = true;
    disputeProposals.set(proposalId.toString(), proposal);

    events.push(new DisputeEvent({
        id: eventId,
        dispute: proposal,
        eventName: 'DisputeProposalExpiredCancelled',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        cancelledBy: cancelledBy.toLowerCase()
    }));

    ctx.log.info(`Dispute proposal ${proposalId} for trade ${tradeId} expired and cancelled by ${cancelledBy}`);
}

async function handleDisputePayout(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId, proposalId, recipient, amount, payoutType] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);
    
    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for DisputePayout event`);
        return;
    }

    const payoutTypeEnum = payoutType === 0 ? DisputeStatus.REFUND : DisputeStatus.RESOLVE;

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'DisputePayout',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        payoutRecipient: recipient.toLowerCase(),
        payoutAmount: amount,
        payoutType: payoutTypeEnum,
        relatedProposalId: proposalId.toString()
    }));

    ctx.log.info(`Dispute payout for trade ${tradeId}: ${amount} to ${recipient} (type: ${payoutTypeEnum})`);
}

// ########################### oracle events ##########################

async function handleOracleUpdateProposed(
    log: any,
    proposals: Map<string, OracleUpdateProposal>,
    events: OracleEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, proposer, newOracle, eta, emergencyFastTrack] = log.args;

    // Calculate expiration (7 days TTL)
    const GOVERNANCE_PROPOSAL_TTL = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(timestamp.getTime() + GOVERNANCE_PROPOSAL_TTL);

    const proposal = new OracleUpdateProposal({
        id: proposalId.toString(),
        proposalId: proposalId.toString(),
        newOracle: newOracle.toLowerCase(),
        approvalCount: 1,
        executed: false,
        createdAt: timestamp,
        eta: eta,
        proposer: proposer.toLowerCase(),
        emergencyFastTrack: Boolean(emergencyFastTrack),
        expiresAt: expiresAt,
        cancelled: false
    });

    proposals.set(proposalId.toString(), proposal);

    events.push(new OracleEvent({
        id: eventId,
        oracleUpdate: proposal,
        eventName: 'OracleUpdateProposed',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        proposedOracle: newOracle.toLowerCase(),
        eta: eta,
        proposer: proposer.toLowerCase()
    }));

    ctx.log.info(`Oracle update proposed: ${proposalId} to ${newOracle} by ${proposer} (fastTrack=${emergencyFastTrack})`);
}

async function handleOracleUpdateApproved(
    log: any,
    proposals: Map<string, OracleUpdateProposal>,
    events: OracleEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, approver, approvalCount, requiredApprovals] = log.args;

    let proposal = proposals.get(proposalId.toString());
    if (!proposal) {
        proposal = await ctx.store.get(OracleUpdateProposal, proposalId.toString());
        if (!proposal) {
            ctx.log.error(`Oracle update proposal ${proposalId} not found`);
            return;
        }
        proposals.set(proposalId.toString(), proposal);
    }

    proposal.approvalCount = Number(approvalCount);
    proposals.set(proposalId.toString(), proposal);

    events.push(new OracleEvent({
        id: eventId,
        oracleUpdate: proposal,
        eventName: 'OracleUpdateApproved',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        approver: approver.toLowerCase(),
        approvalCount: Number(approvalCount),
        requiredApprovals: Number(requiredApprovals)
    }));

    ctx.log.info(`Oracle update ${proposalId} approved by ${approver}`);
}

async function handleOracleUpdated(
    log: any,
    events: OracleEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [oldOracle, newOracle] = log.args;

    events.push(new OracleEvent({
        id: eventId,
        oracleUpdate: null as any,
        eventName: 'OracleUpdated',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        oldOracle: oldOracle.toLowerCase(),
        newOracle: newOracle.toLowerCase()
    }));

    ctx.log.info(`Oracle updated from ${oldOracle} to ${newOracle}`);
}

async function handleOracleUpdateProposalExpiredCancelled(
    log: any,
    proposals: Map<string, OracleUpdateProposal>,
    events: OracleEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, cancelledBy] = log.args;

    let proposal = proposals.get(proposalId.toString());
    if (!proposal) {
        proposal = await ctx.store.get(OracleUpdateProposal, proposalId.toString());
        if (!proposal) {
            ctx.log.error(`Oracle update proposal ${proposalId} not found`);
            return;
        }
        proposals.set(proposalId.toString(), proposal);
    }

    proposal.cancelled = true;
    proposals.set(proposalId.toString(), proposal);

    events.push(new OracleEvent({
        id: eventId,
        oracleUpdate: proposal,
        eventName: 'OracleUpdateProposalExpiredCancelled',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        cancelledBy: cancelledBy.toLowerCase()
    }));

    ctx.log.info(`Oracle update proposal ${proposalId} expired and cancelled by ${cancelledBy}`);
}

async function handleOracleDisabledEmergency(
    log: any,
    events: OracleEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [disabledBy, previousOracle] = log.args;

    events.push(new OracleEvent({
        id: eventId,
        oracleUpdate: null as any,
        eventName: 'OracleDisabledEmergency',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        disabledBy: disabledBy.toLowerCase(),
        previousOracle: previousOracle.toLowerCase()
    }));

    ctx.log.info(`Oracle disabled in emergency by ${disabledBy} - previous oracle: ${previousOracle}`);
}

// ########################### admin events ##########################

async function handleAdminAddProposed(
    log: any,
    proposals: Map<string, AdminAddProposal>,
    events: AdminEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, proposer, newAdmin, eta] = log.args;

    // Calculate expiration (7 days TTL)
    const GOVERNANCE_PROPOSAL_TTL = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(timestamp.getTime() + GOVERNANCE_PROPOSAL_TTL);

    const proposal = new AdminAddProposal({
        id: proposalId.toString(),
        proposalId: proposalId.toString(),
        newAdmin: newAdmin.toLowerCase(),
        approvalCount: 1,
        executed: false,
        createdAt: timestamp,
        eta: eta,
        proposer: proposer.toLowerCase(),
        expiresAt: expiresAt,
        cancelled: false
    });

    proposals.set(proposalId.toString(), proposal);

    events.push(new AdminEvent({
        id: eventId,
        adminAddProposal: proposal,
        eventName: 'AdminAddProposed',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        proposedAdmin: newAdmin.toLowerCase(),
        eta: eta,
        proposer: proposer.toLowerCase()
    }));

    ctx.log.info(`Admin add proposed: ${proposalId} to add ${newAdmin}`);
}

async function handleAdminAddApproved(
    log: any,
    proposals: Map<string, AdminAddProposal>,
    events: AdminEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, approver, approvalCount, requiredApprovals] = log.args;

    let proposal = proposals.get(proposalId.toString());
    if (!proposal) {
        proposal = await ctx.store.get(AdminAddProposal, proposalId.toString());
        if (!proposal) {
            ctx.log.error(`Admin add proposal ${proposalId} not found`);
            return;
        }
        proposals.set(proposalId.toString(), proposal);
    }

    proposal.approvalCount = Number(approvalCount);
    proposals.set(proposalId.toString(), proposal);

    events.push(new AdminEvent({
        id: eventId,
        adminAddProposal: proposal,
        eventName: 'AdminAddApproved',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        approver: approver.toLowerCase(),
        approvalCount: Number(approvalCount),
        requiredApprovals: Number(requiredApprovals)
    }));

    ctx.log.info(`Admin add ${proposalId} approved by ${approver}`);
}

async function handleAdminAdded(
    log: any,
    events: AdminEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [newAdmin] = log.args;

    events.push(new AdminEvent({
        id: eventId,
        adminAddProposal: null as any,
        eventName: 'AdminAdded',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        addedAdmin: newAdmin.toLowerCase()
    }));

    ctx.log.info(`Admin added: ${newAdmin}`);
}

async function handleAdminAddProposalExpiredCancelled(
    log: any,
    proposals: Map<string, AdminAddProposal>,
    events: AdminEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, cancelledBy] = log.args;

    let proposal = proposals.get(proposalId.toString());
    if (!proposal) {
        proposal = await ctx.store.get(AdminAddProposal, proposalId.toString());
        if (!proposal) {
            ctx.log.error(`Admin add proposal ${proposalId} not found`);
            return;
        }
        proposals.set(proposalId.toString(), proposal);
    }

    proposal.cancelled = true;
    proposals.set(proposalId.toString(), proposal);

    events.push(new AdminEvent({
        id: eventId,
        adminAddProposal: proposal,
        eventName: 'AdminAddProposalExpiredCancelled',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        cancelledBy: cancelledBy.toLowerCase()
    }));

    ctx.log.info(`Admin add proposal ${proposalId} expired and cancelled by ${cancelledBy}`);
}

// ########################### system events ##########################

async function handlePaused(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [triggeredBy] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'Paused',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: triggeredBy.toLowerCase()
    }));

    ctx.log.info(`System paused by ${triggeredBy}`);
}

async function handleUnpauseProposed(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [triggeredBy] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'UnpauseProposed',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: triggeredBy.toLowerCase()
    }));

    ctx.log.info(`Unpause proposed by ${triggeredBy}`);
}

async function handleUnpauseApproved(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [triggeredBy, approvalCount, requiredApprovals] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'UnpauseApproved',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: triggeredBy.toLowerCase()
    }));

    ctx.log.info(`Unpause approved by ${triggeredBy} (${approvalCount}/${requiredApprovals})`);
}

async function handleUnpauseProposalCancelled(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [triggeredBy] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'UnpauseProposalCancelled',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: triggeredBy.toLowerCase()
    }));

    ctx.log.info(`Unpause proposal cancelled by ${triggeredBy}`);
}

async function handleUnpaused(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [triggeredBy] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'Unpaused',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: triggeredBy.toLowerCase()
    }));

    ctx.log.info(`System unpaused by ${triggeredBy}`);
}

// ########################### claim events ##########################

const CLAIM_TYPE_VALUES = Object.values(ClaimType);

async function handleClaimableAccrued(
    log: any,
    trades: Map<string, Trade>,
    events: TradeEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [tradeId, recipient, amount, claimType] = log.args;

    const trade = await getOrLoadTrade(tradeId.toString(), trades, ctx);

    if (!trade) {
        ctx.log.error(`Trade ${tradeId} not found for ClaimableAccrued event`);
        return;
    }

    const claimTypeEnum = CLAIM_TYPE_VALUES[Number(claimType)] ?? null;

    events.push(new TradeEvent({
        id: eventId,
        trade,
        eventName: 'ClaimableAccrued',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        claimType: claimTypeEnum,
        claimRecipient: recipient.toLowerCase(),
        claimAmount: amount
    }));

    ctx.log.info(`Trade ${tradeId} claimable accrued: ${amount} to ${recipient} (type: ${claimTypeEnum})`);
}

async function handleClaimed(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [claimant, amount] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'Claimed',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: claimant.toLowerCase(),
        claimAmount: amount
    }));

    ctx.log.info(`Claimed ${amount} by ${claimant}`);
}

async function handleTreasuryClaimed(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [treasuryIdentity, payoutReceiver, amount, triggeredBy] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'TreasuryClaimed',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: triggeredBy.toLowerCase(),
        claimAmount: amount,
        treasuryIdentity: treasuryIdentity.toLowerCase(),
        payoutReceiver: payoutReceiver.toLowerCase()
    }));

    ctx.log.info(`Treasury claimed ${amount} to ${payoutReceiver} by ${triggeredBy}`);
}

async function handleTreasuryPayoutAddressUpdateProposed(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, proposer, newPayoutReceiver, eta] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'TreasuryPayoutAddressUpdateProposed',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        proposalId: proposalId.toString(),
        triggeredBy: proposer.toLowerCase(),
        newPayoutReceiver: newPayoutReceiver.toLowerCase(),
        payoutReceiver: newPayoutReceiver.toLowerCase(),
        eta
    }));

    ctx.log.info(`Treasury payout receiver update proposed: proposal=${proposalId} newReceiver=${newPayoutReceiver}`);
}

async function handleTreasuryPayoutAddressUpdateApproved(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, approver, approvalCount, requiredApprovals] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'TreasuryPayoutAddressUpdateApproved',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        proposalId: proposalId.toString(),
        triggeredBy: approver.toLowerCase(),
        approvalCount: Number(approvalCount),
        requiredApprovals: Number(requiredApprovals)
    }));

    ctx.log.info(`Treasury payout receiver update approved: proposal=${proposalId} approver=${approver} approvals=${approvalCount}/${requiredApprovals}`);
}

async function handleTreasuryPayoutAddressUpdated(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [oldPayoutReceiver, newPayoutReceiver] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'TreasuryPayoutAddressUpdated',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        oldPayoutReceiver: oldPayoutReceiver.toLowerCase(),
        newPayoutReceiver: newPayoutReceiver.toLowerCase(),
        payoutReceiver: newPayoutReceiver.toLowerCase()
    }));

    ctx.log.info(`Treasury payout receiver updated: old=${oldPayoutReceiver} new=${newPayoutReceiver}`);
}

async function handleTreasuryPayoutAddressUpdateProposalExpiredCancelled(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [proposalId, cancelledBy] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'TreasuryPayoutAddressUpdateProposalExpiredCancelled',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        proposalId: proposalId.toString(),
        triggeredBy: cancelledBy.toLowerCase()
    }));

    ctx.log.info(`Treasury payout receiver update proposal expired and cancelled: proposal=${proposalId} by=${cancelledBy}`);
}

async function handleClaimsPaused(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [triggeredBy] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'ClaimsPaused',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: triggeredBy.toLowerCase()
    }));

    ctx.log.info(`Claims paused by ${triggeredBy}`);
}

async function handleClaimsUnpaused(
    log: any,
    events: SystemEvent[],
    eventId: string,
    block: any,
    timestamp: Date,
    txHash: string | null,
    extrinsicHash: string | null,
    extrinsicIndex: number,
    ctx: any
) {
    const [triggeredBy] = log.args;

    events.push(new SystemEvent({
        id: eventId,
        eventName: 'ClaimsUnpaused',
        blockNumber: block.header.height,
        timestamp,
        txHash,
        extrinsicHash,
        extrinsicIndex,
        triggeredBy: triggeredBy.toLowerCase()
    }));

    ctx.log.info(`Claims unpaused by ${triggeredBy}`);
}
