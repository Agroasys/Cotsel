import { ethers } from 'ethers';
import type { GovernedUnpauseEvidence } from '../types';

/** `PauseScope.TRADE` in `AgroasysEscrow`. */
export const PAUSE_SCOPE_TRADE = 2;

const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/u;

/**
 * A release was refused because the transaction offered does not prove the
 * governed decision it was offered as.
 */
export class GovernedApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernedApprovalError';
  }
}

/**
 * Normalize first, then validate: a hash copied out of a block explorer can
 * arrive with surrounding whitespace and in either case, and rejecting it for
 * that would be a worse experience than the check is worth.
 */
export function normalizeTxHash(raw: string): string {
  const normalized = raw.trim().toLowerCase();

  if (!TX_HASH_PATTERN.test(normalized)) {
    throw new GovernedApprovalError(
      `--approval-tx must be a 32-byte transaction hash, received "${raw}"`,
    );
  }

  return normalized;
}

/**
 * The two ways an incident reference can legitimately appear as the escrow's
 * `bytes32 incidentRef`.
 *
 * `RECON-YYYYMMDD-XXXXXXXX` is 22 bytes, so an operator can carry it on chain
 * literally, which keeps the proposal readable in a block explorer. Hashing it
 * is the other honest encoding. Both are unambiguous bindings to one incident;
 * anything else is a proposal about something other than this containment.
 */
export function incidentRefCandidates(incidentReference: string): string[] {
  return [
    ethers.encodeBytes32String(incidentReference).toLowerCase(),
    ethers.keccak256(ethers.toUtf8Bytes(incidentReference)).toLowerCase(),
  ];
}

export function matchesIncidentReference(onchainRef: string, incidentReference: string): boolean {
  return incidentRefCandidates(incidentReference).includes(onchainRef.toLowerCase());
}

export interface UnpauseLog {
  address: string;
  tradeId: string;
  logIndex: number;
}

export interface ApprovalLog {
  address: string;
  approver: string;
  approvalCount: number;
  requiredApprovals: number;
  logIndex: number;
}

export interface OnchainUnpauseProposal {
  scope: number;
  tradeId: string;
  incidentRef: string;
  approvalCount: number;
  executed: boolean;
}

/** Everything read back from the chain about one candidate approval transaction. */
export interface GovernedUnpauseFacts {
  txHash: string;
  chainId: number;
  escrowAddress: string;
  /** Null when the node has no receipt for the hash at all. */
  receiptStatus: number | null;
  blockNumber: number;
  blockHash: string;
  /** Block timestamp in seconds, as the chain reports it. */
  blockTimestamp: number;
  /** The highest block the run's finality preference will vouch for. */
  finalityBlockNumber: number;
  unpausedLogs: UnpauseLog[];
  approvalLogs: ApprovalLog[];
  /** The escrow's proposal slot read at `blockNumber`, i.e. just after execution. */
  proposal: OnchainUnpauseProposal;
}

export interface ContainmentUnderRelease {
  tradeId: string;
  incidentReference: string;
  openedAt: Date;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Decide whether a transaction is the governed unpause that authorises
 * releasing one containment, and reduce it to the evidence worth keeping.
 *
 * Every check here exists because an approval reference that is merely a string
 * proves nothing: anyone with write access to this database could have typed
 * one. What makes a release defensible is that the decision happened on the
 * chain the escrow lives on, in the escrow itself, for *this* trade, under the
 * incident this containment was opened for, with the quorum the contract
 * required — and that the same decision cannot be presented twice.
 *
 * Pure on purpose: the chain reads happen in the caller, so every rule can be
 * exercised against fabricated facts without an RPC endpoint.
 */
export function evaluateGovernedUnpause(
  facts: GovernedUnpauseFacts,
  containment: ContainmentUnderRelease,
): GovernedUnpauseEvidence {
  if (facts.receiptStatus === null) {
    throw new GovernedApprovalError(
      `No transaction receipt found for ${facts.txHash}; the approval must be a mined transaction`,
    );
  }

  if (facts.receiptStatus !== 1) {
    throw new GovernedApprovalError(
      `Transaction ${facts.txHash} reverted; a failed transaction approves nothing`,
    );
  }

  // The pause is what is being lifted, so the evidence that lifts it must be at
  // least as durable as the state it changes. Releasing on a re-orgable block
  // could clear a containment whose unpause later never happened.
  if (facts.blockNumber > facts.finalityBlockNumber) {
    throw new GovernedApprovalError(
      `Transaction ${facts.txHash} is in block ${facts.blockNumber}, past the finality boundary ` +
        `${facts.finalityBlockNumber}; wait for it to finalize before releasing`,
    );
  }

  const unpaused = facts.unpausedLogs.find(
    (log) => sameAddress(log.address, facts.escrowAddress) && log.tradeId === containment.tradeId,
  );

  if (!unpaused) {
    throw new GovernedApprovalError(
      `Transaction ${facts.txHash} emits no TradeUnpaused for trade ${containment.tradeId} from ` +
        `escrow ${facts.escrowAddress}; it is not the governed recovery for this containment`,
    );
  }

  const { proposal } = facts;
  if (proposal.scope !== PAUSE_SCOPE_TRADE) {
    throw new GovernedApprovalError(
      `The proposal executed by ${facts.txHash} has scope ${proposal.scope}, not a per-trade ` +
        'unpause; a global or claims recovery does not release a contained trade',
    );
  }

  if (proposal.tradeId !== containment.tradeId) {
    throw new GovernedApprovalError(
      `The proposal executed by ${facts.txHash} unpauses trade ${proposal.tradeId}, not ` +
        `${containment.tradeId}`,
    );
  }

  if (!proposal.executed) {
    throw new GovernedApprovalError(
      `The proposal read at block ${facts.blockNumber} is not marked executed; ${facts.txHash} did ` +
        'not carry an unpause to quorum',
    );
  }

  if (!matchesIncidentReference(proposal.incidentRef, containment.incidentReference)) {
    throw new GovernedApprovalError(
      `The proposal executed by ${facts.txHash} carries incident reference ${proposal.incidentRef}, ` +
        `which is not ${containment.incidentReference}; approvals are not transferable between ` +
        'incidents',
    );
  }

  const approvals = facts.approvalLogs.filter((log) =>
    sameAddress(log.address, facts.escrowAddress),
  );
  // The contract emits one approval per approver and executes on the last, so
  // the final log is the one that carries the counts the unpause ran under.
  const finalApproval = approvals[approvals.length - 1];
  if (!finalApproval) {
    throw new GovernedApprovalError(
      `Transaction ${facts.txHash} records no UnpauseApproved; the quorum it executed under cannot ` +
        'be established',
    );
  }

  if (finalApproval.requiredApprovals < 1) {
    throw new GovernedApprovalError(
      `Transaction ${facts.txHash} executed against a required-approval count of ` +
        `${finalApproval.requiredApprovals}; refusing to treat that as a quorum`,
    );
  }

  if (finalApproval.approvalCount < finalApproval.requiredApprovals) {
    throw new GovernedApprovalError(
      `Transaction ${facts.txHash} reached ${finalApproval.approvalCount} of ` +
        `${finalApproval.requiredApprovals} required approvals`,
    );
  }

  // An unpause that predates the incident cannot be the recovery from it. This
  // is what stops an old, genuine governance receipt being presented against a
  // containment opened afterwards.
  const executedAt = new Date(facts.blockTimestamp * 1000);
  if (executedAt.getTime() <= containment.openedAt.getTime()) {
    throw new GovernedApprovalError(
      `Transaction ${facts.txHash} executed at ${executedAt.toISOString()}, at or before incident ` +
        `${containment.incidentReference} was opened at ${containment.openedAt.toISOString()}; an ` +
        'earlier approval cannot release a later containment',
    );
  }

  return {
    txHash: facts.txHash,
    chainId: facts.chainId,
    contractAddress: facts.escrowAddress,
    tradeId: containment.tradeId,
    blockNumber: facts.blockNumber,
    blockHash: facts.blockHash,
    logIndex: unpaused.logIndex,
    incidentRef: proposal.incidentRef,
    // Only the approvals that landed in the executing transaction are provable
    // from it. Earlier approvals are in their own transactions; the counts
    // below are the contract's own record that the quorum was met.
    approvers: approvals.map((log) => log.approver),
    approvalCount: finalApproval.approvalCount,
    requiredApprovals: finalApproval.requiredApprovals,
    executedAt,
  };
}
