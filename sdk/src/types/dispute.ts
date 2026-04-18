/**
 * SPDX-License-Identifier: Apache-2.0
 */
export enum DisputeStatus {
  REFUND = 0,
  RESOLVE = 1,
}

export interface DisputeProposal {
  proposalId: string;
  tradeId: string;
  disputeStatus: DisputeStatus;
  approvalCount: number;
  executed: boolean;
  createdAt: Date;
  proposer: string;
}

export interface DisputeResult {
  txHash: string;
  blockNumber: number;
}

export interface DisputeProposalResult extends DisputeResult {
  proposalId?: bigint;
}
